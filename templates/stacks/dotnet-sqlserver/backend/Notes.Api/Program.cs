using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Notes.Api.Data;

var builder = WebApplication.CreateBuilder(args);

var connectionString = builder.Configuration["DATABASE_URL"]
    ?? throw new InvalidOperationException("Set DATABASE_URL to the SQL Server connection string");
builder.Services.AddDbContext<NotesDb>(options => options.UseSqlServer(connectionString).UseSnakeCaseNamingConvention());
builder.Services.ConfigureHttpJsonOptions(options => options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower);
builder.WebHost.UseUrls($"http://127.0.0.1:{builder.Configuration["PORT"] ?? "8000"}");

var app = builder.Build();

// Errors become {"error": "..."} with the right status
app.Use(async (context, next) =>
{
    try
    {
        await next(context);
    }
    catch (NotFoundException error)
    {
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        await context.Response.WriteAsJsonAsync(new { error = error.Message });
    }
    catch (Exception error)
    {
        app.Logger.LogError(error, "{Method} {Path} failed", context.Request.Method, context.Request.Path);
        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
        await context.Response.WriteAsJsonAsync(new { error = "Something went wrong" });
    }
});

app.MapGet("/api/health", () => new { ok = true });

// Pinned notes first, then the newest
app.MapGet("/api/notes", async (NotesDb db) =>
    await db.Notes.OrderByDescending(n => n.Pinned).ThenByDescending(n => n.CreatedAt).ThenByDescending(n => n.Id).ToListAsync());

app.MapPost("/api/notes/{id:int}/pin", (int id, NotesDb db) => SetPinned(db, id, true));
app.MapPost("/api/notes/{id:int}/unpin", (int id, NotesDb db) => SetPinned(db, id, false));

app.Run();

static async Task<Note> SetPinned(NotesDb db, int id, bool pinned)
{
    var note = await db.Notes.FindAsync(id) ?? throw new NotFoundException($"Note {id} not found");
    note.Pinned = pinned;
    await db.SaveChangesAsync();
    return note;
}

/// <summary>A note (or anything else) that doesn't exist: 404</summary>
public class NotFoundException(string message) : Exception(message);

/// <summary>Lets the tests start the app in memory (WebApplicationFactory)</summary>
public partial class Program;
