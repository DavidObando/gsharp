// <copyright file="GeneratedPartModifiersTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GSharp.GeneratorHost
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Issues #5252 / #5253 (parts of #5217): what modifiers a generated part prints,
/// given the shape the user declared. The stub keeps a class `abstract` for a
/// generator when it only inherits unimplemented abstract members (ADR-0195), and
/// a generator mirrors the stub's modifiers; the user's declared shape, not the
/// stub's, decides what the generated part states.
///
/// The contract, one row per test (the witness is the change that makes the row fail):
///
/// | Row | User declares | Generator emits | Generated part prints | Witness |
/// | --- | --- | --- | --- | --- |
/// | JsonSerializerContext repro | `partial class Target : Base`, inherits abstract `Visit` | `abstract partial`, `override Visit` | no `abstract`, no `open` on the part or `Visit`; `Target()` binds | translator keeps the mirrored `abstract`; member `open` ignores the printed type |
/// | Declared abstract | `abstract partial class Target` | `abstract partial` | `abstract` stays; type stays abstract | the renderer records declared-abstract types as semantic |
/// | Only semantic, not mirrored | `partial class Target : Base` | plain `partial` | no `abstract`; no `open` header or member | header openness ignores the semantic-only set |
/// | Semantic, user `open` | `open partial class Target : Base` | `abstract partial` | no `abstract`; `Visit` stays `open override` | declared openness not carried to the members |
/// | Interface implementing | `partial class Target : Base, IFace` | `abstract partial`, `override Visit`, `Run` | no `abstract`/`open`; both members present | translator keeps the mirrored `abstract`; member `open` ignores the printed type |
/// | Nested partials | `partial class Target : Base` | `abstract partial` with a nested `abstract class Inner` | `Target` cleared; the generator's own nested `abstract class Inner` stays | translator keeps the mirrored `abstract` (nested row also fails if clearing reached the generator's own nested type) |
/// | Struct | `partial struct Target` | `partial struct` | `partial struct`, no modifiers added | none: guards unchanged behaviour (passes on the old build too) |
/// | Record | `partial data class Target(N int32)` | `partial record` | `partial data class`, no `abstract`/`open` | none: guards unchanged behaviour (passes on the old build too) |
open class GeneratedPartModifiersTests {
    shared {
        private const Base string = "open class Base { open func Visit() int32; }\n"
    }

    @Fact
    func JsonSerializerContextShape_GeneratedPartStatesNeitherAbstractNorOpen() {
        let run = Run(
            Base + "partial class Target : Base {}\nfunc Make() Target -> Target()\n",
            "namespace App { public abstract partial class Target : Base { public override int Visit() => 1; } }"
        )
        Assert.Empty(run.Errors)
        Assert.Contains("partial class Target", run.Part, StringComparison.Ordinal)
        Assert.DoesNotContain("abstract", run.Part, StringComparison.Ordinal)
        Assert.DoesNotContain("open", run.Part, StringComparison.Ordinal)
        Assert.Contains("override func Visit", run.Part, StringComparison.Ordinal)
        Assert.False(run.Target.IsAbstract)
    }

    @Fact
    func DeclaredAbstract_StaysAbstractInTheGeneratedPart() {
        let run = Run(
            "abstract partial class Target { func Shape() int32 { return 1 } }\n",
            "namespace App { public abstract partial class Target { public int Extra => 1; } }"
        )
        Assert.Empty(run.Errors)
        Assert.Contains("abstract partial class Target", run.Part, StringComparison.Ordinal)
        Assert.True(run.Target.IsAbstract)
    }

    @Fact
    func SemanticOnly_NotMirroredByTheGenerator_PrintsNoOpenHeaderOrMember() {
        let run = Run(
            Base + "partial class Target : Base {}\nfunc Make() Target -> Target()\n",
            "namespace App { public partial class Target : Base { public override int Visit() => 1; } }"
        )
        Assert.Empty(run.Errors)
        Assert.DoesNotContain("open", run.Part, StringComparison.Ordinal)
        Assert.DoesNotContain("abstract", run.Part, StringComparison.Ordinal)
        Assert.False(run.Target.IsOpen)
    }

    @Fact
    func SemanticOnly_UserDeclaredOpen_KeepsMemberOpenness() {
        let run = Run(
            Base + "open partial class Target : Base {}\nfunc Make() Target -> Target()\n",
            "namespace App { public abstract partial class Target : Base { public override int Visit() => 1; } }"
        )
        Assert.Empty(run.Errors)
        Assert.DoesNotContain("abstract", run.Part, StringComparison.Ordinal)
        Assert.DoesNotContain("open partial", run.Part, StringComparison.Ordinal)
        Assert.Contains("open override func Visit", run.Part, StringComparison.Ordinal)
        Assert.True(run.Target.IsOpen)
        Assert.False(run.Target.IsAbstract)
    }

    @Fact
    func InterfaceImplementingPartial_GeneratedPartHasBothMembersAndNoModifiers() {
        let run = Run(
            Base +
                "interface IFace { func Run() int32 }\npartial class Target : Base, IFace {}\nfunc Make() Target -> Target()\n",
            "namespace App { public abstract partial class Target : Base, IFace { public override int Visit() => 1; public int Run() => 2; } }"
        )
        Assert.Empty(run.Errors)
        Assert.DoesNotContain("abstract", run.Part, StringComparison.Ordinal)
        Assert.DoesNotContain("open", run.Part, StringComparison.Ordinal)
        Assert.Contains("override func Visit", run.Part, StringComparison.Ordinal)
        Assert.Contains("func Run", run.Part, StringComparison.Ordinal)
    }

    @Fact
    func NestedPartials_OnlyTheStubTypeIsCleared_ANestedGeneratorTypeKeepsItsOwnAbstract() {
        let run = Run(
            Base + "partial class Target : Base {}\nfunc Make() Target -> Target()\n",
            "namespace App { public abstract partial class Target : Base { public override int Visit() => 1; " +
                "public abstract class Inner { public abstract int Size(); } } }"
        )
        Assert.Empty(run.Errors)
        Assert.Contains("partial class Target", run.Part, StringComparison.Ordinal)
        Assert.DoesNotContain("abstract partial class Target", run.Part, StringComparison.Ordinal)
        Assert.Contains("abstract class Inner", run.Part, StringComparison.Ordinal)
        Assert.False(run.Target.IsAbstract)
    }

    @Fact
    func Struct_GeneratedPartAddsNoModifiers() {
        let run = Run(
            "partial struct Target { var A int32 }\n",
            "namespace App { public partial struct Target { public int B => 1; } }"
        )
        Assert.Empty(run.Errors)
        Assert.Contains("partial struct Target", run.Part, StringComparison.Ordinal)
        Assert.DoesNotContain("abstract", run.Part, StringComparison.Ordinal)
        Assert.DoesNotContain("open", run.Part, StringComparison.Ordinal)
    }

    @Fact
    func Record_GeneratedPartIsADataPartWithoutAbstractOrOpen() {
        let run = Run(
            "partial data class Target(N int32)\n",
            "namespace App { public partial record Target { public int Extra => 1; } }"
        )
        Assert.Empty(run.Errors)
        Assert.Contains("partial data class Target", run.Part, StringComparison.Ordinal)
        Assert.DoesNotContain("abstract", run.Part, StringComparison.Ordinal)
        Assert.DoesNotContain("open", run.Part, StringComparison.Ordinal)
    }

    @Fact
    func GeneratedParts_AreByteStableAcrossRuns() {
        let user = Base + "partial class Target : Base {}\nfunc Make() Target -> Target()\n"
        const generated = "namespace App { public abstract partial class Target : Base { public override int Visit() => 1; } }"
        Assert.Equal(Run(user, generated).Part, Run(user, generated).Part)
    }

    private class RowRun {
        init(part string, errors IReadOnlyList[string], target StructSymbol) {
            Part = part
            Errors = errors
            Target = target
        }

        prop Part string {
            get;
        }

        prop Errors IReadOnlyList[string] {
            get;
        }

        prop Target StructSymbol {
            get;
        }
    }

    /// Runs the row's generator over the user's G#, then binds the user's source together with the
    /// back-translated part.
    private func Run(userBody string, generatedCSharp string) RowRun {
        let userSource = "package App\n" + userBody
        let userTree = GsSyntaxTree.Parse(SourceText.From(userSource, "User.gs"))
        let user = Compilation(userTree){IsLibrary = true}
        let result = GeneratorHostRunner.Run(
            user,
            CSharpProjectLoader.RuntimeReferences(),
            []IIncrementalGenerator{FixedSourceGenerator(generatedCSharp)}
        )
        Assert.Empty(result.Failures)
        Assert.Empty(result.HostDiagnostics)
        let (hintName, part) = Assert.Single(result.GeneratedGsFiles)
        let combined = Compilation(userTree, GsSyntaxTree.Parse(SourceText.From(part, hintName + ".gs"))){
            IsLibrary = true
        }
        let errors = combined
            .GlobalScope
            .Diagnostics
            .Concat(combined.BoundProgram.Diagnostics)
            .Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
            .Select((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id + ": " + diagnostic.Message)
            .ToList()
        let target = combined.GlobalScope.Structs.Single((type StructSymbol) -> type.Name == "Target")
        return RowRun(part, errors, target)
    }

    private class FixedSourceGenerator : IIncrementalGenerator {
        private let source string

        init(source string) {
            this.source = source
        }

        func Initialize(context IncrementalGeneratorInitializationContext) {
            let text = "#nullable enable\n" + this.source
            context.RegisterSourceOutput(
                context.CompilationProvider,
                (spc SourceProductionContext, _ Microsoft.CodeAnalysis.Compilation) -> spc.AddSource(
                    "Target.g.cs",
                    text
                )
            )
        }
    }
}
