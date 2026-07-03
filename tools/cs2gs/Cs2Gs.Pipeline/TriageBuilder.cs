// <copyright file="TriageBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
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

    // The leading identifier/keyword token of a (trimmed) line — the position
    // a G# statement/declaration keyword actually occupies syntactically.
    // Used by ClassifyGsLine (issue #1750) instead of scanning the whole line,
    // which can match keyword text that only happens to appear inside a
    // string literal.
    private static readonly Regex LeadingTokenPattern = new Regex(
        @"^[A-Za-z_][A-Za-z0-9_]*",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    // Every modifier keyword the G# printer can emit ahead of a construct
    // keyword (issue #1750 B1), audited from Cs2Gs.CodeModel.Printing.GSharpPrinter:
    // RenderVisibility (public/internal/private/protected), the unsafe/open/
    // sealed/abstract prefixes on RenderTypeDeclaration, the open/override
    // prefixes on RenderProperty, the open/override/async prefixes on
    // RenderMethod, and the `inline` prefix RenderKindKeyword emits ahead of
    // `struct` for TypeDeclarationKind.InlineStruct (issue #1851). `static`,
    // `virtual`, and `export` are not currently emitted by the printer but are
    // kept in the set defensively so a future modifier the printer starts
    // emitting doesn't silently collapse back into the generic bucket.
    // `data` (DataClass/DataStruct's `data class`/`data struct`) is
    // deliberately NOT added here: it is already its own entry in the
    // construct-keyword list below, so those lines classify as
    // DataConstruct rather than falling through to the generic bucket.
    private static readonly HashSet<string> ModifierTokens = new HashSet<string>(StringComparer.Ordinal)
    {
        "public", "private", "internal", "protected", "static", "async", "sealed",
        "abstract", "virtual", "override", "export", "open", "unsafe", "inline",
    };

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

        // ADR-0138: a construct registered as deliberately rejected keeps the
        // long-standing CS2GS-UNSUPPORTED id; an accidental fallthrough (a
        // construct neither translated nor registered with a rationale) is a
        // coverage hole and gets its own id so ledger/CI can treat it as a
        // distinct, always-actionable class.
        string diagnosticId = diagnostic.Classification == UnsupportedClassification.ByDesign
            ? "CS2GS-UNSUPPORTED"
            : "CS2GS-GAP";
        artifact.Diagnostic = new TriageDiagnostic
        {
            Id = diagnosticId,
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
            snippet);
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
            parseError);
        artifact.SuggestedIssue = this.UnsupportedIssue(artifact);
        return artifact;
    }

    /// <summary>
    /// Builds an artifact for a project that failed to bind in C# — MSBuild
    /// workspace load errors captured in
    /// <see cref="Cs2Gs.Translator.Loading.LoadedCSharpProject.ErrorDiagnostics"/>
    /// (ADR-0115 §C, issue #1742). Callers must check
    /// <see cref="Cs2Gs.Translator.Loading.LoadedCSharpProject.BoundWithoutErrors"/>
    /// and stop before translating any document: a project that does not even
    /// bind produces only confusing downstream binding noise otherwise.
    /// </summary>
    /// <param name="stage">The stage the load happened in (its own project for stage 1, the <c>.Tests</c> project for stage 4).</param>
    /// <param name="category">The triage category to file the artifact under.</param>
    /// <param name="errors">The load-error diagnostics (<see cref="Cs2Gs.Translator.Loading.LoadedCSharpProject.ErrorDiagnostics"/>).</param>
    /// <returns>The populated triage artifact.</returns>
    public TriageArtifact ProjectLoadFailure(
        MigrationStageKind stage,
        TriageCategory category,
        IReadOnlyList<Diagnostic> errors)
    {
        if (errors is null || errors.Count == 0)
        {
            throw new ArgumentException("errors must be a non-empty list.", nameof(errors));
        }

        string message = string.Join(" | ", errors.Select(d => d.GetMessage()));

        var artifact = this.NewArtifact(stage, category);
        artifact.Diagnostic = new TriageDiagnostic
        {
            Id = errors[0].Id,
            Message = message,
            Severity = "error",
        };
        artifact.SourceLocation = new TriageSourceLocation
        {
            GsFile = null,
            GsLine = null,
            GsColumn = null,
            CsFile = null,
            CsLine = null,
            CsColumn = null,
        };
        artifact.OffendingCSharpConstruct = new TriageOffendingConstruct
        {
            Kind = "ProjectLoad",
            Snippet = Truncate(message),
        };
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic.Id,
            artifact.OffendingCSharpConstruct.Kind,
            message);
        artifact.SuggestedIssue = this.ProjectLoadIssue(artifact);
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
            snippet ?? diagnostic.Message);
        artifact.SuggestedIssue = this.CompileIssue(artifact);
        return artifact;
    }

    /// <summary>
    /// Builds a stage-3 <c>ilverify-failure</c> artifact from a single parsed
    /// <c>ilverify</c> error (ADR-0115 §C/§D). The diagnostic id is the ilverify
    /// error code; the offending construct kind is the failing IL method
    /// skeleton (the best available signal, since the translator keeps no
    /// per-line C#↔G# map yet — a documented fallback when the method is
    /// absent). The C#/G# source positions are <see langword="null"/> for the
    /// same reason. Labels are <c>Oats</c> + <c>cil-emit</c> (§D).
    /// </summary>
    /// <param name="error">The parsed ilverify error.</param>
    /// <param name="gsFile">The emitted G# file (relative path), or null.</param>
    /// <returns>The populated triage artifact.</returns>
    public TriageArtifact IlVerifyFailure(IlVerifyError error, string gsFile = null)
    {
        if (error is null)
        {
            throw new ArgumentNullException(nameof(error));
        }

        string kind = string.IsNullOrWhiteSpace(error.Method) ? "IlMethod" : error.Method;

        var artifact = this.NewArtifact(MigrationStageKind.IlVerify, TriageCategory.IlVerifyFailure);
        artifact.Diagnostic = new TriageDiagnostic
        {
            Id = string.IsNullOrWhiteSpace(error.Code) ? "IlVerifyError" : error.Code,
            Message = error.RawLine,
            Severity = "error",
        };
        artifact.SourceLocation = new TriageSourceLocation
        {
            GsFile = gsFile,
            GsLine = null,
            GsColumn = null,
            CsFile = null,
            CsLine = null,
            CsColumn = null,
        };
        artifact.OffendingCSharpConstruct = new TriageOffendingConstruct
        {
            Kind = kind,
            Snippet = Truncate(error.Method ?? error.RawLine),
        };
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic.Id,
            artifact.OffendingCSharpConstruct.Kind,
            error.Method ?? error.RawLine);
        artifact.SuggestedIssue = this.IlVerifyIssue(artifact);
        return artifact;
    }

    /// <summary>
    /// Builds a stage-4 <c>test-parity-failure</c> artifact for an executable
    /// app whose migrated program stdout diverged from the committed
    /// <c>baseline.stdout.golden</c> (ADR-0115 §C/§E). The diagnostic id is
    /// <c>STDOUT-MISMATCH</c>; the message summarizes the first differing line;
    /// <c>offendingCSharpConstruct.kind</c> is <c>ProgramStdout</c> with the
    /// differing line as the snippet. The C#/G# source positions are
    /// <see langword="null"/> (the divergence is observed at runtime, not at a
    /// source position). Labels are <c>Oats</c> + <c>bug</c> (§D).
    /// </summary>
    /// <param name="diff">The stdout parity mismatch.</param>
    /// <param name="gsFile">The emitted G# file (relative path), or null.</param>
    /// <returns>The populated triage artifact.</returns>
    public TriageArtifact TestParityStdoutFailure(StdoutParityResult diff, string gsFile = null)
    {
        if (diff is null)
        {
            throw new ArgumentNullException(nameof(diff));
        }

        var artifact = this.NewArtifact(MigrationStageKind.TestParity, TriageCategory.TestParityFailure);
        artifact.Diagnostic = new TriageDiagnostic
        {
            Id = "STDOUT-MISMATCH",
            Message = diff.Describe(),
            Severity = "error",
        };
        artifact.SourceLocation = new TriageSourceLocation
        {
            GsFile = gsFile,
            GsLine = null,
            GsColumn = null,
            CsFile = null,
            CsLine = null,
            CsColumn = null,
        };
        artifact.OffendingCSharpConstruct = new TriageOffendingConstruct
        {
            Kind = "ProgramStdout",
            Snippet = Truncate(diff.ExpectedLine ?? diff.ActualLine ?? diff.Describe()),
        };
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic.Id,
            artifact.OffendingCSharpConstruct.Kind,
            diff.ExpectedLine ?? diff.ActualLine ?? diff.Describe());
        artifact.SuggestedIssue = this.TestParityIssue(artifact);
        return artifact;
    }

    /// <summary>
    /// Builds a stage-4 <c>test-parity-failure</c> artifact for a single ported
    /// xUnit test whose outcome diverged from the C# baseline oracle
    /// (ADR-0115 §C/§E). The diagnostic id is <c>TESTPARITY-&lt;kind&gt;</c>
    /// (<c>Missing</c>/<c>Extra</c>/<c>OutcomeMismatch</c>); the message is the
    /// expected-vs-actual description; <c>offendingCSharpConstruct.kind</c> is
    /// the failing test method skeleton (the fully qualified test name). Labels
    /// are <c>Oats</c> + <c>bug</c> (§D). The fingerprint splits per differing
    /// test (the test name is the construct kind).
    /// </summary>
    /// <param name="diff">The per-test parity difference.</param>
    /// <param name="gsFile">The emitted G# test file (relative path), or null.</param>
    /// <returns>The populated triage artifact.</returns>
    public TriageArtifact TestParityTestFailure(TestParityDiff diff, string gsFile = null)
    {
        if (diff is null)
        {
            throw new ArgumentNullException(nameof(diff));
        }

        var artifact = this.NewArtifact(MigrationStageKind.TestParity, TriageCategory.TestParityFailure);
        artifact.Diagnostic = new TriageDiagnostic
        {
            Id = "TESTPARITY-" + diff.Kind,
            Message = diff.Describe(),
            Severity = "error",
        };
        artifact.SourceLocation = new TriageSourceLocation
        {
            GsFile = gsFile,
            GsLine = null,
            GsColumn = null,
            CsFile = null,
            CsLine = null,
            CsColumn = null,
        };
        artifact.OffendingCSharpConstruct = new TriageOffendingConstruct
        {
            Kind = diff.Name,
            Snippet = Truncate(diff.Describe()),
        };
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic.Id,
            artifact.OffendingCSharpConstruct.Kind,
            diff.Describe());
        artifact.SuggestedIssue = this.TestParityIssue(artifact);
        return artifact;
    }

    /// <summary>
    /// Builds a stage-4 <c>test-parity-failure</c> artifact for a library app
    /// whose translated G# test project failed to build against the
    /// locally-built <c>Gsharp.NET.Sdk</c> (issue #1749 mode 1). A library that
    /// green-built standalone with <c>gsc</c> in stage 2 but fails to build here
    /// is a real regression — the SDK/build surface broke, not "not verified
    /// yet" — so this is reported as a failure, never a skip. The diagnostic id
    /// is <c>LIBRARY-BUILD-FAILED</c>; the message is the tail of the captured
    /// <c>dotnet test</c> output.
    /// </summary>
    /// <param name="output">The captured <c>dotnet test</c> output (already truncated by the caller).</param>
    /// <param name="gsFile">The emitted G# library file (relative path), or null.</param>
    /// <returns>The populated triage artifact.</returns>
    public TriageArtifact TestParityLibraryBuildFailure(string output, string gsFile = null)
    {
        string message = string.IsNullOrWhiteSpace(output) ? "(no build output captured)" : output.Trim();

        var artifact = this.NewArtifact(MigrationStageKind.TestParity, TriageCategory.TestParityFailure);
        artifact.Diagnostic = new TriageDiagnostic
        {
            Id = "LIBRARY-BUILD-FAILED",
            Message = message,
            Severity = "error",
        };
        artifact.SourceLocation = new TriageSourceLocation
        {
            GsFile = gsFile,
            GsLine = null,
            GsColumn = null,
            CsFile = null,
            CsLine = null,
            CsColumn = null,
        };
        artifact.OffendingCSharpConstruct = new TriageOffendingConstruct
        {
            Kind = "LibraryBuild",
            Snippet = Truncate(message),
        };
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic.Id,
            artifact.OffendingCSharpConstruct.Kind,
            message);
        artifact.SuggestedIssue = this.TestParityIssue(artifact);
        return artifact;
    }

    /// <summary>
    /// Builds a triage artifact for an unhandled exception thrown by a stage
    /// itself, rather than a diagnostic the stage reported normally (issue
    /// #1750). The offending construct <c>kind</c> is the exception's runtime
    /// type name — a structural, deterministic signal — rather than any text
    /// pulled from <see cref="Exception.Message"/>: crash messages routinely
    /// embed run-scoped absolute paths (temp/work directories that include the
    /// run id) that differ machine-to-machine and run-to-run, so fingerprinting
    /// on the raw message text kept the same recurring crash from ever
    /// deduping. <see cref="Exception.Message"/> is still recorded in full on
    /// <see cref="TriageDiagnostic.Message"/> for human triage; it is simply
    /// not the fingerprint's construct-kind signal (its embedded paths are
    /// also normalized generically by <see cref="Fingerprint.NormalizeShape"/>
    /// as a second line of defense).
    /// </summary>
    /// <param name="stage">The stage that crashed.</param>
    /// <param name="category">The triage category to file the crash artifact under.</param>
    /// <param name="diagnosticId">The diagnostic id to stamp (stage-specific, e.g. <c>GS9999</c>).</param>
    /// <param name="ex">The exception the stage threw.</param>
    /// <returns>The populated triage artifact.</returns>
    public TriageArtifact StageCrash(MigrationStageKind stage, TriageCategory category, string diagnosticId, Exception ex)
    {
        if (ex is null)
        {
            throw new ArgumentNullException(nameof(ex));
        }

        string kind = ex.GetType().Name;
        string message = $"{TriageSerialization.StageName(stage)} stage crashed ({kind}): {ex.Message}";

        var artifact = this.NewArtifact(stage, category);
        artifact.Diagnostic = new TriageDiagnostic
        {
            Id = diagnosticId,
            Message = message,
            Severity = "error",
        };
        artifact.SourceLocation = new TriageSourceLocation
        {
            GsFile = null,
            GsLine = null,
            GsColumn = null,
            CsFile = null,
            CsLine = null,
            CsColumn = null,
        };
        artifact.OffendingCSharpConstruct = new TriageOffendingConstruct
        {
            Kind = kind,
            Snippet = Truncate(message),
        };
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic.Id,
            artifact.OffendingCSharpConstruct.Kind,
            message);
        artifact.SuggestedIssue = category switch
        {
            TriageCategory.CompileError => this.CompileIssue(artifact),
            TriageCategory.IlVerifyFailure => this.IlVerifyIssue(artifact),
            TriageCategory.TestParityFailure => this.TestParityIssue(artifact),
            _ => this.UnsupportedIssue(artifact),
        };
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

        // Structural signal (issue #1750): classify on the *leading* token of
        // the statement/declaration only — the syntactic position where a G#
        // keyword actually appears — never on substring content anywhere in
        // the line. Scanning the whole line (the prior `Contains(" for ")`
        // behavior) misclassifies a line like `let msg = "run for cover"` as
        // a `for` construct because the keyword happens to appear inside a
        // string literal; the leading token of that line is `let`, which is
        // unaffected by what the string literal contains.
        // Skip past any leading modifier run (issue #1750 B1) — G# construct
        // lines routinely carry modifiers ahead of the actual construct
        // keyword (`sealed class Shape {`, `async func Bump(...)`,
        // `private func Helper(...)`, `public static func F()`). Matching only
        // the very first token misclassifies every modifier-prefixed
        // construct into the generic bucket, colliding structurally distinct
        // gaps. Walk forward token-by-token — still by syntactic position,
        // never by scanning the whole line — until the token isn't a modifier.
        string remainder = line.TrimStart();
        Match leadingToken = LeadingTokenPattern.Match(remainder);
        while (leadingToken.Success && ModifierTokens.Contains(leadingToken.Value))
        {
            remainder = remainder.Substring(leadingToken.Index + leadingToken.Length).TrimStart();
            leadingToken = LeadingTokenPattern.Match(remainder);
        }

        if (!leadingToken.Success)
        {
            return "GSharpConstruct";
        }

        string token = leadingToken.Value;
        string[] keywords =
        {
            "func", "class", "struct", "data", "interface", "enum", "let", "const",
            "for", "foreach", "while", "if", "return", "import", "package",
        };

        foreach (string keyword in keywords)
        {
            if (string.Equals(token, keyword, StringComparison.Ordinal))
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

    private TriageSuggestedIssue ProjectLoadIssue(TriageArtifact artifact)
    {
        string title = $"[cs2gs] project failed to load ({this.CorpusAppId})";
        string[] lines =
        {
            $"MSBuild could not bind the C# project for **{this.CorpusAppId}** " +
                $"(gsc {this.GscVersion}) — missing SDK/targets, an unresolved project reference, " +
                "or an unsupported TFM.",
            string.Empty,
            $"- Diagnostic: `{artifact.Diagnostic.Id}` — {artifact.Diagnostic.Message}",
            string.Empty,
            "**Reproduction:** run `cs2gs migrate` over the corpus; the project load gate fails before " +
                "any document is translated.",
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

    private TriageSuggestedIssue IlVerifyIssue(TriageArtifact artifact)
    {
        string title = $"[cs2gs] ilverify {artifact.Diagnostic.Id} in translated {this.CorpusAppId} " +
            $"({artifact.OffendingCSharpConstruct.Kind})";
        string repro = "**Reproduction:** `cs2gs migrate` translates the corpus app, compiles it with `gsc`, " +
            "then runs `dotnet tool run ilverify <assembly> -s System.Private.CoreLib -r <refs>` which surfaces this error.";
        string[] lines =
        {
            $"The assembly emitted for **{this.CorpusAppId}** fails IL verification with " +
                $"`dotnet-ilverify` (gsc {this.GscVersion}).",
            string.Empty,
            $"- Error code: `{artifact.Diagnostic.Id}`",
            $"- Method: `{artifact.OffendingCSharpConstruct.Kind}`",
            $"- ilverify: `{artifact.Diagnostic.Message}`",
            string.Empty,
            "This is a CIL-emission gap: `gsc` accepted the program but produced IL the verifier rejects " +
                "(and the error is not one of the two documented ilverify false-positive bundles).",
            repro,
            $"**Fingerprint:** `{artifact.Fingerprint}`",
        };

        var issue = new TriageSuggestedIssue
        {
            Title = title,
            Body = string.Join("\n", lines),
        };
        issue.Labels.Add("Oats");
        issue.Labels.Add("cil-emit");
        return issue;
    }

    private TriageSuggestedIssue TestParityIssue(TriageArtifact artifact)
    {
        string title = $"[cs2gs] test-parity {artifact.Diagnostic.Id} in migrated {this.CorpusAppId} " +
            $"({artifact.OffendingCSharpConstruct.Kind})";
        bool isStdout = string.Equals(artifact.Diagnostic.Id, "STDOUT-MISMATCH", StringComparison.Ordinal);
        bool isBuildFailure = string.Equals(artifact.Diagnostic.Id, "LIBRARY-BUILD-FAILED", StringComparison.Ordinal);
        string repro = isStdout
            ? "**Reproduction:** `cs2gs migrate` translates the corpus app, compiles it with `gsc`, runs the " +
                "produced program, and compares its stdout to `baseline.stdout.golden`."
            : "**Reproduction:** `cs2gs migrate` translates the corpus app and its `.Tests` project to a G# xUnit " +
                "project, runs `dotnet test`, and compares the per-test outcomes to `baseline.tests.json`.";
        string[] lines =
        {
            $"The migrated **{this.CorpusAppId}** does not reproduce the C# parity oracle with `gsc` {this.GscVersion}.",
            string.Empty,
            $"- Failure: `{artifact.Diagnostic.Id}`",
            $"- Detail: {artifact.Diagnostic.Message}",
            isStdout ? "- This is a behavioral divergence: the program compiled but produced different output." :
                isBuildFailure ? "- This is a build regression: the app compiled with `gsc` in stage 2 but the " +
                    "translated G# test project failed to build against the locally-built SDK here." :
                $"- Failing test: `{artifact.OffendingCSharpConstruct.Kind}`",
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
