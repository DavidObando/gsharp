// <copyright file="TranslateStage.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Stage 1 (ADR-0115 §C): load the C# project, translate each document to
/// canonical G#, write the <c>.gs</c> set, and round-trip-parse every emitted
/// file with the real G# parser. Pass gate: every file parses AND zero
/// <see cref="TranslationSeverity.Unsupported"/> diagnostics. On failure the
/// category is <c>translation-unsupported</c> and the app short-circuits.
/// </summary>
public sealed class TranslateStage : IMigrationStage
{
    /// <inheritdoc/>
    public MigrationStageKind Kind => MigrationStageKind.Translate;

    /// <inheritdoc/>
    public async Task<StageOutcome> ExecuteAsync(
        StageExecutionContext context,
        CancellationToken cancellationToken = default)
    {
        if (context is null)
        {
            throw new ArgumentNullException(nameof(context));
        }

        LoadedCSharpProject project = await CSharpProjectLoader
            .LoadProjectAsync(context.App.ProjectPath, cancellationToken)
            .ConfigureAwait(false);

        var artifacts = new List<TriageArtifact>();
        Directory.CreateDirectory(context.AppRunDir);

        foreach (LoadedDocument document in project.Documents)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var translationContext = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);

            CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, translationContext);
            string printed = GSharpPrinter.Print(unit);

            string gsFileName = Path.GetFileNameWithoutExtension(document.FilePath) + ".gs";
            string gsPath = Path.Combine(context.AppRunDir, gsFileName);
            File.WriteAllText(gsPath, printed);

            string relativeGsPath = MigrationPipeline.SanitizeAppId(context.App.Id) + "/" + gsFileName;
            var emitted = new EmittedGsFile(gsPath, relativeGsPath, document.FilePath, printed);
            context.EmittedFiles.Add(emitted);

            foreach (TranslationDiagnostic diagnostic in translationContext.Diagnostics
                .Where(d => d.Severity == TranslationSeverity.Unsupported))
            {
                artifacts.Add(context.Triage.TranslationUnsupported(diagnostic));
            }

            RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
            if (!roundTrip.Success)
            {
                artifacts.Add(context.Triage.RoundTripFailure(
                    emitted,
                    roundTrip.Errors.FirstOrDefault() ?? "unknown parse error"));
            }
        }

        return artifacts.Count == 0 ? StageOutcome.Passed() : StageOutcome.Failed(artifacts);
    }
}
