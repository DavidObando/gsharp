// <copyright file="TriageBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.Translator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Builds schema-v1.0 triage artifacts (ADR-0115 §D.1), pre-stamped with the
/// run provenance, computing the dedup fingerprint (§D.2) and the pre-rendered
/// <c>suggestedIssue</c>. The <c>retryHistory</c> is left empty here and filled
/// by <see cref="MigrationPipeline"/>, which alone sees prior runs.
/// </summary>
public sealed class TriageBuilder
{
    private const int SnippetMaxLength = 160;

    /// <summary>
    /// Initializes a new instance of the <see cref="TriageBuilder"/> class.
    /// </summary>
    /// <param name="runId">The run id stamped on every artifact.</param>
    /// <param name="timestamp">The ISO-8601 UTC run timestamp.</param>
    /// <param name="gscVersion">The compiler version stamped on every artifact.</param>
    /// <param name="corpusAppId">The corpus app id stamped on every artifact.</param>
    public TriageBuilder(string runId, string timestamp, string gscVersion, string corpusAppId)
    {
        this.RunId = runId;
        this.Timestamp = timestamp;
        this.GscVersion = gscVersion;
        this.CorpusAppId = corpusAppId;
    }

    /// <summary>Gets the run id.</summary>
    public string RunId { get; }

    /// <summary>Gets the ISO-8601 UTC run timestamp.</summary>
    public string Timestamp { get; }

    /// <summary>Gets the compiler version.</summary>
    public string GscVersion { get; }

    /// <summary>Gets the corpus app id.</summary>
    public string CorpusAppId { get; }

    /// <summary>
    /// Builds a stage-1 <c>translation-unsupported</c> artifact from a translator
    /// diagnostic. The C# location/snippet come from the diagnostic's Roslyn
    /// location; the G# side is <see langword="null"/> because no canonical
    /// <c>.gs</c> is emitted for an unsupported construct (documented null rule).
    /// </summary>
    /// <param name="diagnostic">The translator diagnostic.</param>
    /// <returns>The populated triage artifact.</returns>
    public TriageArtifact TranslationUnsupported(TranslationDiagnostic diagnostic)
    {
        if (diagnostic is null)
        {
            throw new ArgumentNullException(nameof(diagnostic));
        }

        (string csFile, int? csLine, int? csColumn, string snippet) = ResolveCSharpLocation(diagnostic.Location);
        snippet ??= diagnostic.Message;

        var artifact = this.NewArtifact(MigrationStageKind.Translate, TriageCategory.TranslationUnsupported);
        artifact.Diagnostic = new TriageDiagnostic
        {
            Id = "CS2GS-UNSUPPORTED",
            Message = diagnostic.Message,
            Severity = "error",
        };
        artifact.SourceLocation = new TriageSourceLocation
        {
            GsFile = null,
            GsLine = null,
            GsColumn = null,
            CsFile = csFile,
            CsLine = csLine,
            CsColumn = csColumn,
        };
        artifact.OffendingCSharpConstruct = new TriageOffendingConstruct
        {
            Kind = diagnostic.ConstructKind,
            Snippet = Truncate(snippet),
        };
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic.Id,
            artifact.OffendingCSharpConstruct.Kind,
            artifact.OffendingCSharpConstruct.Snippet);
        artifact.SuggestedIssue = this.UnsupportedIssue(artifact);
        return artifact;
    }

    /// <summary>
    /// Builds a stage-1 <c>translation-unsupported</c> artifact for an emitted
    /// <c>.gs</c> that fails to round-trip-parse — a translator defect that still
    /// gates stage 1 (ADR-0115 §C).
    /// </summary>
    /// <param name="file">The emitted G# file that failed to parse.</param>
    /// <param name="parseError">The first G# parser error text.</param>
    /// <returns>The populated triage artifact.</returns>
    public TriageArtifact RoundTripFailure(EmittedGsFile file, string parseError)
    {
        if (file is null)
        {
            throw new ArgumentNullException(nameof(file));
        }

        var artifact = this.NewArtifact(MigrationStageKind.Translate, TriageCategory.TranslationUnsupported);
        artifact.Diagnostic = new TriageDiagnostic
        {
            Id = "CS2GS-ROUNDTRIP",
            Message = "Emitted G# did not round-trip-parse: " + parseError,
            Severity = "error",
        };
        artifact.SourceLocation = new TriageSourceLocation
        {
            GsFile = file.RelativeGsPath,
            GsLine = null,
            GsColumn = null,
            CsFile = file.CsFilePath,
            CsLine = null,
            CsColumn = null,
        };
        artifact.OffendingCSharpConstruct = new TriageOffendingConstruct
        {
            Kind = "CompilationUnit",
            Snippet = Truncate(parseError),
        };
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic.Id,
            artifact.OffendingCSharpConstruct.Kind,
            artifact.OffendingCSharpConstruct.Snippet);
        artifact.SuggestedIssue = this.UnsupportedIssue(artifact);
        return artifact;
    }

    /// <summary>
    /// Builds a stage-2 <c>compile-error</c> artifact from a single <c>gsc</c>
    /// diagnostic. The G# location is precise (from <c>gsc</c>); the C# side is
    /// <see langword="null"/> because the translator keeps no per-line C#↔G#
    /// position map yet (documented null rule). The offending construct is the
    /// emitted G# line that <c>gsc</c> flagged.
    /// </summary>
    /// <param name="diagnostic">The <c>gsc</c> error diagnostic.</param>
    /// <param name="file">The emitted G# file the diagnostic anchors to.</param>
    /// <returns>The populated triage artifact.</returns>
    public TriageArtifact CompileError(GscDiagnostic diagnostic, EmittedGsFile file)
    {
        if (diagnostic is null)
        {
            throw new ArgumentNullException(nameof(diagnostic));
        }

        string snippet = file is null ? null : LineAt(file.GSharpSource, diagnostic.Line);
        string kind = ClassifyGsLine(snippet);

        var artifact = this.NewArtifact(MigrationStageKind.Compile, TriageCategory.CompileError);
        artifact.Diagnostic = new TriageDiagnostic
        {
            Id = diagnostic.Id,
            Message = diagnostic.Message,
            Severity = diagnostic.Severity,
        };
        artifact.SourceLocation = new TriageSourceLocation
        {
            GsFile = file?.RelativeGsPath,
            GsLine = diagnostic.Line,
            GsColumn = diagnostic.Column,
            CsFile = null,
            CsLine = null,
            CsColumn = null,
        };
        artifact.OffendingCSharpConstruct = new TriageOffendingConstruct
        {
            Kind = kind,
            Snippet = Truncate(snippet ?? diagnostic.Message),
        };
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic.Id,
            artifact.OffendingCSharpConstruct.Kind,
            artifact.OffendingCSharpConstruct.Snippet);
        artifact.SuggestedIssue = this.CompileIssue(artifact);
        return artifact;
    }

    private static (string File, int? Line, int? Column, string Snippet) ResolveCSharpLocation(Location location)
    {
        if (location is null || !location.IsInSource)
        {
            return (null, null, null, null);
        }

        FileLinePositionSpan span = location.GetLineSpan();
        int line = span.StartLinePosition.Line + 1;
        int column = span.StartLinePosition.Character + 1;
        string snippet = null;

        SourceText text = location.SourceTree?.GetText();
        if (text is not null && span.StartLinePosition.Line < text.Lines.Count)
        {
            snippet = text.Lines[span.StartLinePosition.Line].ToString().Trim();
        }

        return (span.Path, line, column, snippet);
    }

    private static string LineAt(string source, int oneBasedLine)
    {
        if (string.IsNullOrEmpty(source) || oneBasedLine < 1)
        {
            return null;
        }

        string[] lines = source.Replace("\r\n", "\n").Split('\n');
        return oneBasedLine <= lines.Length ? lines[oneBasedLine - 1].Trim() : null;
    }

    private static string ClassifyGsLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return "GSharpConstruct";
        }

        string trimmed = line.TrimStart();
        string[] keywords =
        {
            "func", "class", "struct", "data", "interface", "enum", "let", "const",
            "for", "foreach", "while", "if", "return", "import", "package",
        };

        foreach (string keyword in keywords)
        {
            if (trimmed.StartsWith(keyword + " ", StringComparison.Ordinal) ||
                trimmed.Contains(" " + keyword + " ", StringComparison.Ordinal))
            {
                return char.ToUpperInvariant(keyword[0]) + keyword.Substring(1) + "Construct";
            }
        }

        return "GSharpConstruct";
    }

    private static string Truncate(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return value;
        }

        string oneLine = value.Replace("\r", " ").Replace("\n", " ").Trim();
        return oneLine.Length <= SnippetMaxLength ? oneLine : oneLine.Substring(0, SnippetMaxLength) + "…";
    }

    private static string LocationSuffix(int? line, int? column) =>
        line.HasValue ? $" ({line}{(column.HasValue ? "," + column : string.Empty)})" : string.Empty;

    private TriageArtifact NewArtifact(MigrationStageKind stage, TriageCategory category)
    {
        var artifact = new TriageArtifact
        {
            RunId = this.RunId,
            Timestamp = this.Timestamp,
            GscVersion = this.GscVersion,
            CorpusAppId = this.CorpusAppId,
            Stage = TriageSerialization.StageName(stage),
            Category = TriageSerialization.CategoryName(category),
        };
        return artifact;
    }

    private TriageSuggestedIssue UnsupportedIssue(TriageArtifact artifact)
    {
        string title = $"[cs2gs] Unsupported C# construct '{artifact.OffendingCSharpConstruct.Kind}' " +
            $"has no canonical G# form ({this.CorpusAppId})";
        string csLine = $"- C# source: `{artifact.SourceLocation.CsFile}`" +
            LocationSuffix(artifact.SourceLocation.CsLine, artifact.SourceLocation.CsColumn);
        string[] lines =
        {
            $"While migrating **{this.CorpusAppId}**, the translator could not map a C# construct to canonical G#.",
            string.Empty,
            $"- Construct: `{artifact.OffendingCSharpConstruct.Kind}`",
            $"- Detail: {artifact.Diagnostic.Message}",
            csLine,
            $"- Snippet: `{artifact.OffendingCSharpConstruct.Snippet}`",
            string.Empty,
            "**Reproduction:** run `cs2gs migrate` over the corpus; stage 1 (translate) gates on this construct.",
            $"**Fingerprint:** `{artifact.Fingerprint}`",
        };

        var issue = new TriageSuggestedIssue
        {
            Title = title,
            Body = string.Join("\n", lines),
        };
        issue.Labels.Add("Oats");
        return issue;
    }

    private TriageSuggestedIssue CompileIssue(TriageArtifact artifact)
    {
        string title = $"[cs2gs] {artifact.Diagnostic.Id} compiling translated {this.CorpusAppId} " +
            $"({artifact.OffendingCSharpConstruct.Kind})";
        string gsLine = $"- Emitted G#: `{artifact.SourceLocation.GsFile}`" +
            LocationSuffix(artifact.SourceLocation.GsLine, artifact.SourceLocation.GsColumn);
        string repro = "**Reproduction:** `cs2gs migrate` translates the corpus app, writes the `.gs` shown above, " +
            $"then runs `gsc /target:… /out:… {artifact.SourceLocation.GsFile}` which surfaces this error.";
        string[] lines =
        {
            $"The G# emitted for **{this.CorpusAppId}** fails to compile with `gsc` {this.GscVersion}.",
            string.Empty,
            $"- Diagnostic: `{artifact.Diagnostic.Id}` — {artifact.Diagnostic.Message}",
            gsLine,
            $"- Offending line: `{artifact.OffendingCSharpConstruct.Snippet}`",
            string.Empty,
            repro,
            $"**Fingerprint:** `{artifact.Fingerprint}`",
        };

        var issue = new TriageSuggestedIssue
        {
            Title = title,
            Body = string.Join("\n", lines),
        };
        issue.Labels.Add("Oats");
        issue.Labels.Add("bug");
        return issue;
    }
}
