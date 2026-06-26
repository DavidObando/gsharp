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

        var usedGsFileNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (LoadedDocument document in project.Documents)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var translationContext = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);

            CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, translationContext);
            string printed = GSharpPrinter.Print(unit);

            string gsFileName = EmittedFileNaming.UniqueGsFileName(document.FilePath, usedGsFileNames);
            string gsPath = Path.Combine(context.AppRunDir, gsFileName);
            File.WriteAllText(gsPath, printed);

            var declaredTypeNames = new List<string>();
            var baseClassNames = new List<string>();
            CollectTypeGraph(unit.Members, declaredTypeNames, baseClassNames);

            string relativeGsPath = MigrationPipeline.SanitizeAppId(context.App.Id) + "/" + gsFileName;
            var emitted = new EmittedGsFile(
                gsPath,
                relativeGsPath,
                document.FilePath,
                printed,
                declaredTypeNames,
                baseClassNames);
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

    /// <summary>
    /// Walks the emitted declarations of one file, recording the simple names of
    /// the types declared (including nested types) and the simple names of the
    /// base classes they extend. This drives the base-before-subclass compile
    /// ordering in <see cref="CompileStage"/>.
    /// </summary>
    private static void CollectTypeGraph(
        IReadOnlyList<GNode> members,
        List<string> declaredTypeNames,
        List<string> baseClassNames)
    {
        if (members is null)
        {
            return;
        }

        foreach (GNode member in members)
        {
            if (member is TypeDeclaration type)
            {
                declaredTypeNames.Add(type.Name);
                if (type.BaseType is NamedTypeReference baseRef)
                {
                    baseClassNames.Add(SimpleName(baseRef.Name));
                }

                // Implemented interfaces are dependencies too: gsc's interface-
                // satisfaction binding is order-sensitive, so a type must be
                // compiled after the interfaces it declares (CompileStage ordering).
                foreach (GTypeReference iface in type.Interfaces)
                {
                    if (iface is NamedTypeReference ifaceRef)
                    {
                        baseClassNames.Add(SimpleName(ifaceRef.Name));
                    }
                }

                CollectTypeGraph(type.Members, declaredTypeNames, baseClassNames);
            }
        }
    }

    /// <summary>Returns the last dotted segment of a (possibly qualified) name.</summary>
    private static string SimpleName(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return name;
        }

        int dot = name.LastIndexOf('.');
        return dot >= 0 ? name.Substring(dot + 1) : name;
    }
}
