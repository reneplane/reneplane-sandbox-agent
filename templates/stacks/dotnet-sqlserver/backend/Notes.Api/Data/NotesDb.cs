using Microsoft.EntityFrameworkCore;

namespace Notes.Api.Data;

public class Note
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public string Body { get; set; } = "";
    public bool Pinned { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// The database. Tables and columns use snake_case (notes.created_at).
/// Schema changes go through migrations: dotnet ef migrations add &lt;Name&gt; --project Notes.Api
/// </summary>
public class NotesDb(DbContextOptions<NotesDb> options) : DbContext(options)
{
    public DbSet<Note> Notes => Set<Note>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<Note>(note =>
        {
            note.Property(n => n.Title).HasMaxLength(200);
            note.Property(n => n.Pinned).HasDefaultValue(false);
            note.Property(n => n.CreatedAt).HasDefaultValueSql("SYSDATETIMEOFFSET()");
        });
    }
}
