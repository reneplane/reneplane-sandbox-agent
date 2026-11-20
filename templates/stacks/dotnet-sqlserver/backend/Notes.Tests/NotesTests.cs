using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Notes.Api.Data;
using Xunit;

namespace Notes.Tests;

/// <summary>Starts the API in memory against the test database (TEST_DATABASE_URL)</summary>
public class NotesFactory : WebApplicationFactory<Program>
{
    public static readonly string ConnectionString =
        Environment.GetEnvironmentVariable("TEST_DATABASE_URL") ?? Environment.GetEnvironmentVariable("DATABASE_URL") ?? "";

    public NotesFactory() => Environment.SetEnvironmentVariable("DATABASE_URL", ConnectionString);
}

/// <summary>
/// Visible tests. Run them with `dotnet test` or the Run button. Submitting also runs hidden tests.
/// Before every test the database gets every migration (yours too) and the seed rows again.
/// </summary>
public class NotesTests(NotesFactory factory) : IClassFixture<NotesFactory>, IAsyncLifetime
{
    private readonly HttpClient client = factory.CreateClient();

    public async Task InitializeAsync()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<NotesDb>();
        await db.Database.MigrateAsync();
        await db.Database.ExecuteSqlRawAsync("DELETE FROM notes;");
        await db.Database.ExecuteSqlRawAsync(await File.ReadAllTextAsync(FindRepoFile("db/seed.sqlserver.sql")));
    }

    public Task DisposeAsync() => Task.CompletedTask;

    [Fact(DisplayName = "GET /api/notes returns every note")]
    public async Task ReturnsEveryNote()
    {
        var notes = await Notes();
        Assert.Equal(6, notes.Count);
    }

    [Fact(DisplayName = "GET /api/notes puts pinned notes first")]
    public async Task PinnedFirst()
    {
        var pinned = (await Notes()).Select(note => note.GetProperty("pinned").GetBoolean());
        Assert.Equal([true, true, false, false, false, false], pinned);
    }

    [Fact(DisplayName = "GET /api/notes lists the newest first within pinned and unpinned notes")]
    public async Task NewestFirst()
    {
        var ids = (await Notes()).Select(note => note.GetProperty("id").GetInt32());
        Assert.Equal([5, 2, 6, 4, 3, 1], ids);
    }

    [Fact(DisplayName = "POST /api/notes/{id}/pin moves a note to the top")]
    public async Task PinMovesUp()
    {
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/notes/1/pin", null)).StatusCode);
        var ids = (await Notes()).Select(note => note.GetProperty("id").GetInt32()).Take(3);
        Assert.Equal([5, 2, 1], ids);
    }

    [Fact(DisplayName = "POST /api/notes/{id}/pin answers 404 for a note that does not exist")]
    public async Task MissingNote()
    {
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync("/api/notes/999/pin", null)).StatusCode);
    }

    private async Task<List<JsonElement>> Notes()
    {
        var response = await client.GetAsync("/api/notes");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonSerializer.Deserialize<List<JsonElement>>(await response.Content.ReadAsStringAsync())!;
    }

    private static string FindRepoFile(string relative)
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, relative);
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException(relative);
    }
}
