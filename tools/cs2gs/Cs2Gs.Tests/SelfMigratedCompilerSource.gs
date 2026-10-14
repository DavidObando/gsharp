// <copyright file="SelfMigratedCompilerSource.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading.Tasks

/// Issue #4661: the G# form of the compiler's own files, for the tests that
/// guard the SHAPE of that G# (a pattern workaround, a fail-fast bridge that
/// must not appear). Until the cut-over the committed sources are C#, so the
/// G# is what cs2gs produces from them, exactly as the self-migration does.
/// After the cut-over the committed `.gs` files are that G#, so they are
/// read as they are. A requested file that is missing in the tree's language
/// fails loudly: a guard over nothing would pass.
internal shared class SelfMigratedCompilerSource {
    /// One file's G# text and what translating it reported.
    internal class MigratedFile {
        init(text string, diagnostics IReadOnlyList[TranslationDiagnostic]) {
            this.Text = text
            this.Diagnostics = diagnostics
        }

        /// Gets the G# text.
        prop Text string {
            get;
        }

        /// Gets the translation diagnostics; empty for a committed `.gs` file.
        prop Diagnostics IReadOnlyList[TranslationDiagnostic] {
            get;
        }
    }

    /// Whether the source root holds the compiler as G#. Fixed per tree; see
    /// (cref:CommittedCompilerSource.IsGSharp).
    internal prop IsGSharp bool -> CommittedCompilerSource.IsGSharp(TestFixtureSource.Root)

    /// Removes all whitespace, so G# layout cannot decide an assertion.
    /// @param text The G# text.
    /// @returns The text without whitespace.
    internal func Compact(text string) string -> string.Concat(
        text.Where((character char) -> !char.IsWhiteSpace(character))
    )

    /// Loads the G# text of the named files of one project.
    /// @param projectDirectory The project directory relative to the repository, e.g.
    /// `tools/cs2gs/Cs2Gs.Translator`.
    /// @param preservePartialParts Whether translation preserves partial parts, as the self-migration does.
    /// @param fileNames File names without extension (e.g. `CSharpTypeMapper`); empty for every file of the
    /// project.
    /// @returns The files by name without extension.
    internal func LoadAsync(projectDirectory string, preservePartialParts bool, fileNames ...string) Task[
        IReadOnlyDictionary[string, MigratedFile]
    ] -> LoadAsync(TestFixtureSource.Root, projectDirectory, preservePartialParts, fileNames)

    /// Loads the G# text of the named files of one project under an explicit root.
    /// @param root The source root.
    /// @param projectDirectory The project directory relative to the root.
    /// @param preservePartialParts Whether translation preserves partial parts.
    /// @param fileNames File names without extension; empty for every file.
    /// @returns The files by name without extension.
    internal async func LoadAsync(
        root string,
        projectDirectory string,
        preservePartialParts bool,
        fileNames ...string
    ) IReadOnlyDictionary[string, MigratedFile] {
        if CommittedCompilerSource.IsGSharp(root) {
            return ReadCommitted(root, projectDirectory, fileNames)
        }
        let directory = Path.Combine(root, projectDirectory.Replace('/', Path.DirectorySeparatorChar))
        let projectPath = Path.Combine(directory, Path.GetFileName(directory) + ".csproj")
        let project = await CSharpProjectLoader.LoadProjectAsync(projectPath)
        if !project.BoundWithoutErrors {
            throw InvalidOperationException(
                projectDirectory + " should bind with no C# errors:\n" + string.Join("\n", project.ErrorDiagnostics)
            )
        }
        let documents = if fileNames.Length == 0 {
            cast[IEnumerable[LoadedDocument]](project.Documents)
        } else {
            fileNames.Select(
                (name string) -> SelfMigratedCompilerSource.Single(
                    project
                        .Documents
                        .Where((d LoadedDocument) -> Path.GetFileNameWithoutExtension(d.FilePath) == name)
                        .ToList(),
                    name + ".cs",
                    projectDirectory
                )
            )
        }
        let translated = Dictionary[string, MigratedFile](StringComparer.Ordinal)
        for document in documents {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let text = GSharpPrinter.Print(
                CSharpToGSharpTranslator(preservePartialParts: preservePartialParts).TranslateDocument(
                    document,
                    context
                )
            )
            translated.Add(Path.GetFileNameWithoutExtension(document.FilePath), MigratedFile(text, context.Diagnostics))
        }
        return translated
    }

    private func ReadCommitted(root string, projectDirectory string, fileNames[]string) IReadOnlyDictionary[
        string,
        MigratedFile
    ] {
        let committed = CommittedCompilerSource.GSharpFiles(root, projectDirectory)
        let selected = if fileNames.Length == 0 {
            cast[IEnumerable[string]](committed)
        } else {
            fileNames.Select(
                (name string) -> SelfMigratedCompilerSource.Single(
                    committed.Where((path string) -> Path.GetFileNameWithoutExtension(path) == name).ToList(),
                    name + ".gs",
                    projectDirectory
                )
            )
        }
        let files = Dictionary[string, MigratedFile](StringComparer.Ordinal)
        for path in selected {
            files.Add(
                Path.GetFileNameWithoutExtension(path),
                MigratedFile(File.ReadAllText(path), Array.Empty[TranslationDiagnostic]())
            )
        }
        return files
    }

    private func Single[T](matches IReadOnlyList[T], fileName string, projectDirectory string) T {
        if matches.Count != 1 {
            throw InvalidOperationException(
                "Expected exactly one '$fileName' in $projectDirectory, found ${matches.Count}."
            )
        }
        return matches[0]
    }
}
