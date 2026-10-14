// <copyright file="Adr0170EscapedIdentifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// ADR-0170 / issue #3610: escaped identifiers. `$name` spells an
/// ordinary identifier whose semantic name is the characters after the
/// `$` — never keyword-classified, byte-identical metadata to the
/// unescaped name, legal (and redundant) on non-keywords, accepted in every
/// name position including package segments and member access.
open class Adr0170EscapedIdentifierTests {
    @Fact
    func Lexer_EscapedIdentifier_KeepsSourceTextAndCarriesName() {
        let tokens = SyntaxTree.ParseTokens("$$defer")
        let token = Assert.Single(tokens.Where((t SyntaxToken) -> t.Kind != SyntaxKind.EndOfFileToken))
        Assert.Equal(SyntaxKind.IdentifierToken, token.Kind)
        Assert.Equal("$$defer", token.Text)
        Assert.Equal("defer", token.ValueText)
    }

    @Fact
    func Lexer_BareDollar_ReportsBadCharacter() {
        let tree = SyntaxTree.Parse(SourceText.From("var x = $$ 1"))
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Message.Contains("$$", StringComparison.Ordinal))
    }

    @Fact
    func KeywordNamedClass_DeclaresConstructsAndEmitsUnescapedMetadataName() {
        const source = `
package P
import System

class $defer {
    prop Value int32 -> 19
}

let d = $defer{}
Console.WriteLine(d.Value)
`
        let (output, assembly) = CompileLoadRun(source, "Adr0170-Class")
        Assert.Equal("19", output.Trim())
        // ADR-0170 §Metadata: the emitted type's name is the UNESCAPED name.
        Assert.Contains(assembly, (name string) -> name == "defer")
    }

    @Fact
    func EscapedAndPlainSpellings_DenoteTheSameName() {
        const source = (`
package P
import System

class Widget {
    prop Value int32 -> 7
}

// ` + "`" + `$Widget` + "`" + ` ≡ ` + "`" + `Widget` + "`" + `: escaping a non-keyword is legal and redundant.
let w = $Widget{}
Console.WriteLine(w.$Value)
`)
        let (output, _) = CompileLoadRun(source, "Adr0170-Equivalence")
        Assert.Equal("7", output.Trim())
    }

    @Fact
    func KeywordNamedParameterAndLocal_Work() {
        const source = `
package P
import System

func describe($params string) string {
    let $type = $params + "!"
    return $type
}

Console.WriteLine(describe("go"))
`
        let (output, _) = CompileLoadRun(source, "Adr0170-ParamLocal")
        Assert.Equal("go!", output.Trim())
    }

    @Fact
    func KeywordNamedPackageSegment_DeclaresAndEmits() {
        const source = `
package $class.Inner
import System

class Marker {
    prop Value int32 -> 3
}

let m = Marker{}
Console.WriteLine(m.Value)
`
        let (output, _) = CompileLoadRun(source, "Adr0170-Package")
        Assert.Equal("3", output.Trim())
    }

    @Fact
    func KeywordNamedMemberAccess_ResolvesThroughEscape() {
        const source = `
package P
import System

class Bag {
    prop $func int32 -> 11
    func $defer() int32 {
        return this.$func + 1
    }
}

let b = Bag{}
Console.WriteLine(b.$defer())
`
        let (output, assembly) = CompileLoadRun(source, "Adr0170-Members")
        Assert.Equal("12", output.Trim())
        Assert.Contains(assembly, (name string) -> name == "Bag")
    }

    @Fact
    func Interpolation_ResolvesEscapedDeclaredVariableByName() {
        const source = `
package P
import System

var $defer = 41
Console.WriteLine("value=${$defer + 1}")
`
        let (output, _) = CompileLoadRun(source, "Adr0170-Interpolation")
        Assert.Equal("value=42", output.Trim())
    }

    @Fact
    func EscapedSpelling_CannotMintADistinctName() {
        // `$foo` and `foo` declare the SAME name (C#'s @foo rule): the second
        // declaration collides, and the escape never reaches metadata.
        const source = `
package P

var $foo = 1
var foo = 2
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(MemoryStream())
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("foo", StringComparison.Ordinal) && d.Message.Contains(
                "already declared",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func NameOf_EscapedIdentifier_YieldsUnescapedName() {
        // Matches C#: `nameof(@class)` is "class" — the escape is a spelling,
        // not part of the name. Covers the type, member, and local forms.
        const source = `
package P
import System

class $class {
    prop $defer int32 -> 1
}

let $type = 5
Console.WriteLine(nameof($class))
Console.WriteLine(nameof($class.$defer))
Console.WriteLine(nameof($type))
`
        let (output, _) = CompileLoadRun(source, "Adr0170-NameOf")
        Assert.Equal(string.Join(Environment.NewLine, "class", "defer", "type"), output.Trim())
    }

    shared {
        private func CompileLoadRun(source string, contextName string)(Output string, TypeNames[]string) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            Assert.Empty(tree.Diagnostics)
            using let peStream = MemoryStream()
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let typeNames = asm.GetTypes().Select((t Type) -> t.Name).ToArray()
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return (captured.ToString(), typeNames)
            } finally {
                loadContext.Unload()
            }
        }
    }
}
