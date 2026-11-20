// <copyright file="Adr0227TransformationProgramTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.CodeFixes

import GSharp.CodeAnalysis.Transformations
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0227 D6: data-defined transformation programs. JSON round trip and hash, load-time
/// validation, pattern matching, the guard predicates, templates, and the provider's fixes.
open class Adr0227TransformationProgramTests {
    const DropNew string = `{"id":"drop-new","title":"Remove 'new'","trigger":{"diagnosticIds":["GS0125"],"argumentIndex":0,"argumentEquals":"new"},"pattern":{"capture":"kw","kind":"IdentifierToken","text":"new","next":{"capture":"type","kind":"IdentifierToken","sameLine":true}},"guards":[{"predicate":"constructsReferenceType","capture":"type"}],"edits":[{"op":"delete","capture":"kw"}],"applicability":"MachineApplicable","provenance":{"origin":"Mined","source":"s0-dev-20261117","support":40}}`

    const OrToPipes string = `{"id":"or-to-pipes","title":"Use '||'","trigger":{"diagnosticIds":["GS0125"],"argumentIndex":0,"argumentEquals":"or"},"pattern":{"capture":"word","text":"or","previous":{"capture":"left","sameLine":true},"next":{"capture":"right","sameLine":true}},"guards":[{"predicate":"sameLine","capture":"left","other":"right"}],"edits":[{"op":"replace","capture":"word","template":"||"}],"applicability":"MachineApplicable","provenance":{"origin":"HandWritten"}}`

    const NullableDot string = `{"id":"nullable-dot","title":"Use '?.'","trigger":{"diagnosticIds":["GS0158"]},"pattern":{"capture":"member","previous":{"capture":"dot","text":".","previous":{"capture":"receiver"}}},"guards":[{"predicate":"isNullable","capture":"receiver"},{"predicate":"symbolKind","capture":"receiver","value":"parameter"},{"predicate":"typeIs","capture":"receiver","value":"C?"},{"predicate":"kindIs","capture":"dot","value":"DotToken"},{"predicate":"textEquals","capture":"member","value":"N"}],"edits":[{"op":"replace","capture":"dot","template":"?."},{"op":"insertAfter","capture":"member","template":" /* $$ was ${receiver}.${member} */"}],"applicability":"MaybeIncorrect","provenance":{"origin":"Synthesized"}}`

    @Fact
    func Json_RoundTrips_AndTheVersionIsTheHashOfTheCanonicalForm() {
        let program = TransformationProgram.FromJson(DropNew)
        Assert.Equal(DropNew, program.ToJson())
        Assert.Equal(64, program.Version.Length)
        Assert.Equal(program.Version, TransformationProgram.FromJson(program.ToJson()).Version)
        Assert.NotEqual(
            program.Version,
            TransformationProgram.FromJson(DropNew.Replace("\"support\":40", "\"support\":41")).Version
        )
        Assert.Equal(ProgramOrigin.Mined, program.Provenance.Origin)
        Assert.Equal(40, program.Provenance.Support)
        let list = TransformationProgram.ListFromJson("[" + DropNew + "," + OrToPipes + "]")
        Assert.Equal([]string{"drop-new", "or-to-pipes"}, list.Select((p TransformationProgram) -> p.Id).ToArray())
    }

    @Fact
    func InvalidPrograms_AreRejectedAtLoadTime() {
        Assert.Throws[FormatException](
            () -> TransformationProgram.FromJson(DropNew.Replace("constructsReferenceType", "runArbitraryCode"))
        )
        Assert.Throws[FormatException](
            () -> TransformationProgram.FromJson(DropNew.Replace("\"op\":\"delete\"", "\"op\":\"rewrite\""))
        )
        Assert.Throws[FormatException](
            () -> TransformationProgram.FromJson(DropNew.Replace("\"title\"", "\"extra\":1,\"title\""))
        )
        Assert.Throws[FormatException](
            () -> TransformationProgram.FromJson(DropNew.Replace("\"capture\":\"kw\"}]", "\"capture\":\"missing\"}]"))
        )
        Assert.Throws[FormatException](
            () -> TransformationProgram.FromJson(DropNew.Replace("\"capture\":\"type\"", "\"capture\":\"kw\""))
        )
    }

    @Fact
    func DropNewProgram_GivesTheSameEditAsTheBuiltInFix() {
        const source = "package P\n\nclass C { }\n\nfunc F() C {\n    return new C() // keep\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "a.gs"))
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0125")
        let fix = Assert.Single(ProgramService(DropNew).GetFixes(compilation, target))
        Assert.StartsWith(ProgramFixProvider.ProviderIdPrefix + "drop-new@", fix.ProviderId, StringComparison.Ordinal)
        Assert.Equal("drop-new", fix.EquivalenceKey)
        let builtIn = CodeFixService(CodeFixRegistry.CreateDefault()).GetFixes(compilation, target).Single()
        Assert.Equal(
            Assert.Single(fix.GetChanges().Documents).GetChangedText().ToString(),
            Assert.Single(builtIn.GetChanges().Documents).GetChangedText().ToString()
        )
        // A value type fails the guard.
        let structTree = SyntaxTree.Parse(
            "package P\n\nstruct S { var X int32 }\n\nfunc F() S {\n    return new S(1)\n}\n"
        )
        let structCompilation = Compilation(structTree)
        let structTarget = structCompilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(ProgramService(DropNew).GetFixes(structCompilation, structTarget))
    }

    @Fact
    func TriggerArgument_PatternNeighbours_AndSameLine_SelectTheFix() {
        const source = "package P\n\nfunc F(a bool, b bool) bool {\n    return a or b\n}\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let service = ProgramService(OrToPipes, DropNew)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0125")
        let fix = Assert.Single(service.GetFixes(compilation, target))
        Assert.Contains("return a || b", Assert.Single(service.Apply(fix)).Text.ToString())
        // `or` at the end of a line has no right operand on the line.
        let broken = SyntaxTree.Parse("package P\n\nfunc F(a bool, b bool) bool {\n    return a or\n        b\n}\n")
        let brokenCompilation = Compilation(broken)
        let brokenTarget = brokenCompilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(service.GetFixes(brokenCompilation, brokenTarget))
    }

    @Fact
    func SemanticGuards_AndTemplates() {
        const source = "package P\n\nclass C {\n    var N int32\n}\n\nfunc F(c C?) int32? {\n    return c.N\n}\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0158")
        let service = ProgramService(NullableDot)
        let fix = Assert.Single(service.GetFixes(compilation, target))
        Assert.Equal(Applicability.MaybeIncorrect, fix.Applicability)
        let expected = "return c?.N /* " + "$" + " was c.N */\n"
        Assert.Contains(expected, Assert.Single(service.Apply(fix)).Text.ToString())
        // The same program does not fire on a non-nullable receiver.
        let plain = SyntaxTree.Parse(
            "package P\n\nclass C {\n    var M int32\n}\n\nfunc F(c C) int32 {\n    return c.N\n}\n"
        )
        let plainCompilation = Compilation(plain)
        let plainTarget = plainCompilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0158")
        Assert.Empty(service.GetFixes(plainCompilation, plainTarget))
    }

    @Fact
    func Provider_IsDataDefined_AndNamesTheTriggerIds() {
        let provider = ProgramFixProvider(
            ImmutableArray.Create(TransformationProgram.FromJson(OrToPipes), TransformationProgram.FromJson(DropNew))
        )
        Assert.True(provider.IsDataDefined)
        Assert.Equal([]string{"GS0125"}, provider.FixableDiagnosticIds.ToArray())
    }

    @Fact
    func AncestorWithSameLine_MatchesOnlyAnAncestorThatStartsOnTheLine() {
        const program = `{"id":"zero","title":"Use 0","trigger":{"diagnosticIds":["GS0125"]},"pattern":{"capture":"name","ancestor":{"capture":"function","kind":"FunctionDeclaration","sameLine":true}},"edits":[{"op":"replace","capture":"name","template":"0"}],"applicability":"MaybeIncorrect","provenance":{"origin":"HandWritten"}}`
        let service = ProgramService(program)
        for (source, expected) in[](string, bool){
            ("package P\n\nfunc F() int32 -> missing\n", true),
            ("package P\n\nfunc F() int32 {\n    return missing\n}\n", false)
        } {
            let compilation = Compilation(SyntaxTree.Parse(source))
            let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0125")
            Assert.Equal(expected, !service.GetFixes(compilation, target).IsEmpty)
        }
    }

    @Fact
    func ConstructsReferenceType_IsFalseForACallOfAFunctionValue() {
        const source = "package P\n\nclass C { }\n\nfunc F(make () -> C) C {\n    return new make()\n}\n"
        let compilation = Compilation(SyntaxTree.Parse(source))
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(ProgramService(DropNew).GetFixes(compilation, target))
    }

    @Fact
    func IsNullable_AsksWhetherTheTypeItselfIsNullable() {
        const program = `{"id":"safe-dot","title":"Use '?.'","trigger":{"diagnosticIds":["IDS"]},"pattern":{"capture":"member","previous":{"capture":"dot","text":".","previous":{"capture":"receiver"}}},"guards":[{"predicate":"isNullable","capture":"receiver"}],"edits":[{"op":"replace","capture":"dot","template":"?."}],"applicability":"MaybeIncorrect","provenance":{"origin":"HandWritten"}}`
        for (parameter, expected) in[](string, bool){("[]?C", true), ("[]C?", false)} {
            let compilation = Compilation(
                SyntaxTree.Parse(
                    "package P\n\nclass C { }\n\nfunc F(c " + parameter + ") int32 {\n    return c.Nope\n}\n"
                )
            )
            let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            let service = ProgramService(program.Replace("IDS", target.Id))
            Assert.Equal(expected, !service.GetFixes(compilation, target).IsEmpty)
        }
    }

    @Fact
    func LoweringTheApplicability_KeepsTheDataDefinedMark() {
        const source = "package P\n\nclass C { }\n\nfunc F() C {\n    return new C()\n}\n"
        let compilation = Compilation(SyntaxTree.Parse(source))
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0125")
        let fix = Assert.Single(ProgramService(DropNew).GetFixes(compilation, target))
        Assert.True(fix.IsDataDefined)
        let lowered = fix.WithLowerApplicability(Applicability.MaybeIncorrect)
        Assert.NotSame(fix, lowered)
        Assert.True(lowered.IsDataDefined)
    }

    @Fact
    func ArgumentEqualsWithoutAnIndex_AndComparisonsWithoutAValue_AreRejectedAtLoadTime() {
        Assert.Throws[FormatException](
            () -> TransformationProgram.FromJson(DropNew.Replace("\"argumentIndex\":0,", ""))
        )
        for predicate in[]string{"textEquals", "kindIs", "symbolKind", "declaredWith", "typeIs"} {
            Assert.Throws[FormatException](
                () -> TransformationProgram.FromJson(
                    DropNew.Replace("\"predicate\":\"constructsReferenceType\"", "\"predicate\":\"" + predicate + "\"")
                )
            )
        }
    }

    @Fact
    func ConstructsReferenceType_IsFalseForAnEscapedFunctionValue() {
        let source = "package P\n\nclass C { }\n\nfunc F(" +
            "$" +
            "make () -> C) C {\n    return new " +
            "$" +
            "make()\n}\n"
        let compilation = Compilation(SyntaxTree.Parse(source))
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(ProgramService(DropNew).GetFixes(compilation, target))
    }

    @Fact
    func SymbolKind_OfACalledDelegate_IsItsParameter() {
        const program = `{"id":"p","title":"Remove 'new'","trigger":{"diagnosticIds":["GS0125"],"argumentIndex":0,"argumentEquals":"new"},"pattern":{"capture":"kw","text":"new","next":{"capture":"callee","kind":"IdentifierToken"}},"guards":[{"predicate":"symbolKind","capture":"callee","value":"parameter"}],"edits":[{"op":"delete","capture":"kw"}],"applicability":"MaybeIncorrect","provenance":{"origin":"HandWritten"}}`
        const source = "package P\n\nimport System\n\nclass C { }\n\nfunc F(make Func[C]) C {\n    return new make()\n}\n"
        let compilation = Compilation(SyntaxTree.Parse(source))
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0125")
        Assert.Single(ProgramService(program).GetFixes(compilation, target))
    }

    @Fact
    func Guards_FindAnEscapedReceiver_AndAPropertyReceiver() {
        const program = `{"id":"safe-dot","title":"Use '?.'","trigger":{"diagnosticIds":["GS0158"]},"pattern":{"capture":"member","previous":{"capture":"dot","text":".","previous":{"capture":"receiver"}}},"guards":[{"predicate":"isNullable","capture":"receiver"},{"predicate":"typeIs","capture":"receiver","value":"C?"}],"edits":[{"op":"replace","capture":"dot","template":"?."}],"applicability":"MaybeIncorrect","provenance":{"origin":"HandWritten"}}`
        let declaration = "package P\n\nclass C {\n    var N int32\n}\n\n"
        for source in[]string{
            declaration + "func F(" + "$" + "c C?) int32? {\n    return " + "$" + "c.N\n}\n",
            declaration +
                "class D {\n    prop Current C? {\n        get;\n    }\n\n    func F() int32? {\n        return Current.N\n    }\n}\n"
        } {
            let compilation = Compilation(SyntaxTree.Parse(source))
            let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0158")
            Assert.Single(ProgramService(program).GetFixes(compilation, target))
        }
    }

    @Fact
    func AMemberName_DoesNotResolveToALocalOfTheSameName() {
        const program = `{"id":"m","title":"T","trigger":{"diagnosticIds":["IDS"]},"pattern":{"capture":"member","previous":{"text":"."}},"guards":[{"predicate":"symbolKind","capture":"member","value":"local"}],"edits":[{"op":"delete","capture":"member"}],"applicability":"MaybeIncorrect","provenance":{"origin":"HandWritten"}}`
        const source = "package P\n\nclass C { }\n\nfunc F(c C) int32 {\n    let N = 1\n    return c.N\n}\n"
        let compilation = Compilation(SyntaxTree.Parse(source))
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(source.LastIndexOf("N", StringComparison.Ordinal), target.Location.Span.Start)
        Assert.Empty(ProgramService(program.Replace("IDS", target.Id)).GetFixes(compilation, target))
    }

    @Fact
    func TheTypeOfACapturedCallee_IsNotTheTypeOfTheCall() {
        let program = DropNew.Replace("constructsReferenceType", "isNullable")
        const source = "package P\n\nclass C { }\n\nfunc F(make () -> C?) C? {\n    return new make()\n}\n"
        let compilation = Compilation(SyntaxTree.Parse(source))
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(ProgramService(program).GetFixes(compilation, target))
    }

    private func ProgramService(programs ...string) CodeFixService {
        let registry = CodeFixRegistry()
        registry.Add(
            ProgramFixProvider(
                programs.Select((json string) -> TransformationProgram.FromJson(json)).ToImmutableArray()
            )
        )
        return CodeFixService(registry)
    }
}
