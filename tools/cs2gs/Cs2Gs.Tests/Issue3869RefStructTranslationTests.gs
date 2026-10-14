// <copyright file="Issue3869RefStructTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text
import Xunit

/// Issue #3869 defect 1: cs2gs dropped the `ref` from a C# `ref struct`
/// declaration. That is not a cosmetic loss — it changes the emitted type's CLR
/// identity. Without
/// `System.Runtime.CompilerServices.IsByRefLikeAttribute` the type is an
/// ordinary struct, and a struct holding a by-ref-like instance field
/// (`Span<int>`, including an auto-property's backing field) cannot be
/// loaded by the runtime at all: `GetExportedTypes()` throws
/// `TypeLoadException`, xunit discovers nothing, and the whole migrated
/// test assembly silently runs zero tests.
///
/// G# has the construct (ADR-0058 / issue #367, `samples/UserRefStruct.gs`)
/// and gsc emits the attribute (`TypeDefEmitter.EmitIsByRefLikeAttribute`),
/// so this was purely a translator-side gap. The assertions below are therefore
/// deliberately NOT binding-only: the emitted assembly is compiled by gsc, its
/// metadata is read back, and the program is EXECUTED so the CLR type loader is
/// the thing that passes the test.
class Issue3869RefStructTranslationTests {
    /// The declaration keeps its `ref`: `ref struct Name { ... }`, the
    /// spelling `samples/UserRefStruct.gs` uses and gsc's aggregate-head
    /// parser accepts.
    @Fact
    func RefStruct_KeepsTheRefModifier() {
        let printed = Translate(RefStructSource)
        Assert.Contains("ref struct Issue2852ImportedRefStruct", printed, StringComparison.Ordinal)
    }

    /// Anti-vacuity guard: a PLAIN C# struct must not acquire a `ref` it
    /// never had. Without this, "always emit ref" would pass the test above.
    @Fact
    func PlainStruct_DoesNotGainARefModifier() {
        let printed = Translate(`namespace Repro
{
    public struct PlainPoint
    {
        public int X { get; set; }
    }
}`)
        Assert.Contains("struct PlainPoint", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("ref struct PlainPoint", printed, StringComparison.Ordinal)
    }

    /// A C# `class` is never by-ref-like, whatever it holds.
    @Fact
    func Class_DoesNotGainARefModifier() {
        let printed = Translate(`namespace Repro
{
    public class Holder
    {
        public int X { get; set; }
    }
}`)
        Assert.DoesNotContain("ref class", printed, StringComparison.Ordinal)
    }

    /// The executing proof of the whole #3869 chain. The translated G# is
    /// compiled by gsc into an executable that calls `GetExportedTypes()` on
    /// itself — exactly the call xunit's assembly-info shim makes during
    /// discovery. On `origin/main` (the `ref` dropped) the emitted type
    /// carried no `IsByRefLikeAttribute` and this program died with
    /// `System.TypeLoadException: A ByRef or ByRef-like type cannot be used as
    /// the type for an instance field in a non-ByRef-like type`. It must now
    /// load, enumerate, and exit 0 — and the metadata must actually carry the
    /// attribute, so a fix that merely stopped the crash some other way cannot
    /// pass.
    @Fact
    func TranslatedRefStruct_CarriesIsByRefLike_AndTheAssemblyTypeLoads() {
        let compiler string? = FindCompiler()
        Assert.NotNull(compiler)
        let printed = Translate(RefStructSource)
        Assert.Contains("ref struct Issue2852ImportedRefStruct", printed, StringComparison.Ordinal)
        let workDir = NewDirectory("runtime")
        let sourcePath = Path.Combine(workDir, "Repro.gs")
        let outputPath = Path.Combine(workDir, "Repro.dll")
        File.WriteAllText(
            sourcePath,
            printed +
                Environment.NewLine +
                "System.Console.WriteLine(System.Reflection.Assembly.GetExecutingAssembly().GetExportedTypes().Length)" +
                Environment.NewLine
        )
        let (compileExit, compileOutput) = RunDotnet(
            "\"$compiler\" /target:exe /out:\"$outputPath\" \"$sourcePath\"",
            workDir
        )
        Assert.True(compileExit == 0, "gsc must compile the translated `ref struct`. Output:\n" + compileOutput + `
Translated G#:
` + printed)
        {
            using let pe = PEReader(File.OpenRead(outputPath))
            let metadata = pe.GetMetadataReader()
            let definition = metadata
                .TypeDefinitions
                .Select(metadata.GetTypeDefinition)
                .Single(
                (candidate TypeDefinition) -> metadata.GetString(candidate.Name) == "Issue2852ImportedRefStruct"
            )
            Assert.Contains(
                definition
                    .GetCustomAttributes()
                    .Select(metadata.GetCustomAttribute)
                    .Select((attribute CustomAttribute) -> AttributeTypeName(metadata, attribute)),
                (name string) -> name == "IsByRefLikeAttribute"
            )
        }
        // The load-bearing assertion: the CLR type loader, not the binder.
        let (runExit, runOutput) = RunDotnet("\"$outputPath\"", workDir)
        Assert.True(
            runExit == 0,
            "The emitted assembly must type-load and enumerate its exported types " +
                "(this is the call xunit discovery makes). Output:\n" +
                runOutput
        )
        Assert.DoesNotContain("TypeLoadException", runOutput, StringComparison.Ordinal)
    }

    shared {
        private const RefStructSource string = `using System;

namespace Repro
{
    public ref struct Issue2852ImportedRefStruct
    {
        public Span<int> Values { get; set; }
    }
}`

        private func AttributeTypeName(metadata MetadataReader, attribute CustomAttribute) string {
            switch attribute.Constructor.Kind {
                case HandleKind.MemberReference {
                    let member = metadata.GetMemberReference(MemberReferenceHandle(attribute.Constructor))
                    return if member.Parent.Kind == HandleKind.TypeReference {
                        metadata.GetString(metadata.GetTypeReference(TypeReferenceHandle(member.Parent)).Name)
                    } else {
                        string.Empty
                    }
                }
                case HandleKind.MethodDefinition {
                    let method = metadata.GetMethodDefinition(MethodDefinitionHandle(attribute.Constructor))
                    return metadata.GetString(metadata.GetTypeDefinition(method.GetDeclaringType()).Name)
                }
                default {
                    return string.Empty
                }
            }
        }

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Repro.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let translator = CSharpToGSharpTranslator()
            return string.Join(
                Environment.NewLine,
                project.Documents.Select(
                    (document LoadedDocument) -> {
                        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                        let unit = translator.TranslateDocument(document, context)
                        Assert.DoesNotContain(
                            context.Diagnostics,
                            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
                        )
                        return GSharpPrinter.Print(unit)
                    }
                )
            )
        }

        private func NewDirectory(category string) string {
            let path = Path.Combine(
                AppContext.BaseDirectory,
                "issue-3869-ref-struct",
                category,
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(path)
            return path
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }

        private func RunDotnet(arguments string, workingDirectory string)(ExitCode int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDirectory
            }
            using let process Process? = Process.Start(startInfo)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }
    }
}
