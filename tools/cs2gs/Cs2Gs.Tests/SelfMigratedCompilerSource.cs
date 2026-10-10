// <copyright file="SelfMigratedCompilerSource.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4661: the G# form of the compiler's own files, for the tests that
/// guard the SHAPE of that G# (a pattern workaround, a fail-fast bridge that
/// must not appear). Until the cut-over the committed sources are C#, so the
/// G# is what cs2gs produces from them, exactly as the self-migration does.
/// After the cut-over the committed <c>.gs</c> files are that G#, so they are
/// read as they are. A requested file that is missing in the tree's language
/// fails loudly: a guard over nothing would pass.
/// </summary>
internal static class SelfMigratedCompilerSource
{
    /// <summary>One file's G# text and what translating it reported.</summary>
    internal sealed class MigratedFile
    {
        public MigratedFile(string text, IReadOnlyList<TranslationDiagnostic> diagnostics)
        {
            this.Text = text;
            this.Diagnostics = diagnostics;
        }

        /// <summary>Gets the G# text.</summary>
        public string Text { get; }

        /// <summary>Gets the translation diagnostics; empty for a committed <c>.gs</c> file.</summary>
        public IReadOnlyList<TranslationDiagnostic> Diagnostics { get; }
    }

    /// <summary>
    /// Whether the source root holds the compiler as G#. Fixed per tree; see
    /// <see cref="CommittedCompilerSource.IsGSharp"/>.
    /// </summary>
    internal static bool IsGSharp => CommittedCompilerSource.IsGSharp(TestFixtureSource.Root);

    /// <summary>Removes all whitespace, so G# layout cannot decide an assertion.</summary>
    /// <param name="text">The G# text.</param>
    /// <returns>The text without whitespace.</returns>
    internal static string Compact(string text) =>
        string.Concat(text.Where(character => !char.IsWhiteSpace(character)));

    /// <summary>Loads the G# text of the named files of one project.</summary>
    /// <param name="projectDirectory">The project directory relative to the repository, e.g. <c>tools/cs2gs/Cs2Gs.Translator</c>.</param>
    /// <param name="preservePartialParts">Whether translation preserves partial parts, as the self-migration does.</param>
    /// <param name="fileNames">File names without extension (e.g. <c>CSharpTypeMapper</c>); empty for every file of the project.</param>
    /// <returns>The files by name without extension.</returns>
    internal static Task<IReadOnlyDictionary<string, MigratedFile>> LoadAsync(
        string projectDirectory,
        bool preservePartialParts,
        params string[] fileNames) =>
        LoadAsync(TestFixtureSource.Root, projectDirectory, preservePartialParts, fileNames);

    /// <summary>Loads the G# text of the named files of one project under an explicit root.</summary>
    /// <param name="root">The source root.</param>
    /// <param name="projectDirectory">The project directory relative to the root.</param>
    /// <param name="preservePartialParts">Whether translation preserves partial parts.</param>
    /// <param name="fileNames">File names without extension; empty for every file.</param>
    /// <returns>The files by name without extension.</returns>
    internal static async Task<IReadOnlyDictionary<string, MigratedFile>> LoadAsync(
        string root,
        string projectDirectory,
        bool preservePartialParts,
        params string[] fileNames)
    {
        if (CommittedCompilerSource.IsGSharp(root))
        {
            return ReadCommitted(root, projectDirectory, fileNames);
        }

        string directory = Path.Combine(root, projectDirectory.Replace('/', Path.DirectorySeparatorChar));
        string projectPath = Path.Combine(directory, Path.GetFileName(directory) + ".csproj");
        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(projectPath);
        if (!project.BoundWithoutErrors)
        {
            throw new InvalidOperationException(
                projectDirectory + " should bind with no C# errors:\n" + string.Join("\n", project.ErrorDiagnostics));
        }

        IEnumerable<LoadedDocument> documents = fileNames.Length == 0
            ? project.Documents
            : fileNames.Select(name => Single(
                project.Documents.Where(d => Path.GetFileNameWithoutExtension(d.FilePath) == name).ToList(),
                name + ".cs",
                projectDirectory));
        var translated = new Dictionary<string, MigratedFile>(StringComparer.Ordinal);
        foreach (LoadedDocument document in documents)
        {
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            string text = GSharpPrinter.Print(
                new CSharpToGSharpTranslator(preservePartialParts: preservePartialParts)
                    .TranslateDocument(document, context));
            translated.Add(Path.GetFileNameWithoutExtension(document.FilePath), new MigratedFile(text, context.Diagnostics));
        }

        return translated;
    }

    private static IReadOnlyDictionary<string, MigratedFile> ReadCommitted(
        string root,
        string projectDirectory,
        string[] fileNames)
    {
        IReadOnlyList<string> committed = CommittedCompilerSource.GSharpFiles(root, projectDirectory);
        IEnumerable<string> selected = fileNames.Length == 0
            ? committed
            : fileNames.Select(name => Single(
                committed.Where(path => Path.GetFileNameWithoutExtension(path) == name).ToList(),
                name + ".gs",
                projectDirectory));
        var files = new Dictionary<string, MigratedFile>(StringComparer.Ordinal);
        foreach (string path in selected)
        {
            files.Add(
                Path.GetFileNameWithoutExtension(path),
                new MigratedFile(System.IO.File.ReadAllText(path), Array.Empty<TranslationDiagnostic>()));
        }

        return files;
    }

    private static T Single<T>(IReadOnlyList<T> matches, string fileName, string projectDirectory)
    {
        if (matches.Count != 1)
        {
            throw new InvalidOperationException(
                $"Expected exactly one '{fileName}' in {projectDirectory}, found {matches.Count}.");
        }

        return matches[0];
    }
}
