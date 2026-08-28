// <copyright file="Adr0170EscapedIdentifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// ADR-0170 / issue #3610: escaped identifiers. <c>$name</c> spells an
/// ordinary identifier whose semantic name is the characters after the
/// <c>$</c> — never keyword-classified, byte-identical metadata to the
/// unescaped name, legal (and redundant) on non-keywords, accepted in every
/// name position including package segments and member access.
/// </summary>
public class Adr0170EscapedIdentifierTests
{
    [Fact]
    public void Lexer_EscapedIdentifier_KeepsSourceTextAndCarriesName()
    {
        var tokens = SyntaxTree.ParseTokens("$defer");
        var token = Assert.Single(tokens.Where(t => t.Kind != SyntaxKind.EndOfFileToken));
        Assert.Equal(SyntaxKind.IdentifierToken, token.Kind);
        Assert.Equal("$defer", token.Text);
        Assert.Equal("defer", token.ValueText);
    }

    [Fact]
    public void Lexer_BareDollar_ReportsBadCharacter()
    {
        var tree = SyntaxTree.Parse(SourceText.From("var x = $ 1"));
        Assert.Contains(tree.Diagnostics, d => d.Message.Contains("$", StringComparison.Ordinal));
    }

    [Fact]
    public void KeywordNamedClass_DeclaresConstructsAndEmitsUnescapedMetadataName()
    {
        const string source = @"
package P
import System

class $defer {
    prop Value int32 -> 19
}

let d = $defer{}
Console.WriteLine(d.Value)
";
        var (output, assembly) = CompileLoadRun(source, "Adr0170-Class");
        Assert.Equal("19", output.Trim());

        // ADR-0170 §Metadata: the emitted type's name is the UNESCAPED name.
        Assert.Contains(assembly, name => name == "defer");
    }

    [Fact]
    public void EscapedAndPlainSpellings_DenoteTheSameName()
    {
        const string source = @"
package P
import System

class Widget {
    prop Value int32 -> 7
}

// `$Widget` ≡ `Widget`: escaping a non-keyword is legal and redundant.
let w = $Widget{}
Console.WriteLine(w.$Value)
";
        var (output, _) = CompileLoadRun(source, "Adr0170-Equivalence");
        Assert.Equal("7", output.Trim());
    }

    [Fact]
    public void KeywordNamedParameterAndLocal_Work()
    {
        const string source = @"
package P
import System

func describe($params string) string {
    let $type = $params + ""!""
    return $type
}

Console.WriteLine(describe(""go""))
";
        var (output, _) = CompileLoadRun(source, "Adr0170-ParamLocal");
        Assert.Equal("go!", output.Trim());
    }

    [Fact]
    public void KeywordNamedPackageSegment_DeclaresAndEmits()
    {
        const string source = @"
package $class.Inner
import System

class Marker {
    prop Value int32 -> 3
}

let m = Marker{}
Console.WriteLine(m.Value)
";
        var (output, _) = CompileLoadRun(source, "Adr0170-Package");
        Assert.Equal("3", output.Trim());
    }

    [Fact]
    public void KeywordNamedMemberAccess_ResolvesThroughEscape()
    {
        const string source = @"
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
";
        var (output, assembly) = CompileLoadRun(source, "Adr0170-Members");
        Assert.Equal("12", output.Trim());
        Assert.Contains(assembly, name => name == "Bag");
    }

    [Fact]
    public void Interpolation_ResolvesEscapedDeclaredVariableByName()
    {
        const string source = @"
package P
import System

var $defer = 41
Console.WriteLine(""value=${$defer + 1}"")
";
        var (output, _) = CompileLoadRun(source, "Adr0170-Interpolation");
        Assert.Equal("value=42", output.Trim());
    }

    private static (string Output, string[] TypeNames) CompileLoadRun(string source, string contextName)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Empty(tree.Diagnostics);

        using var peStream = new MemoryStream();
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var typeNames = asm.GetTypes().Select(t => t.Name).ToArray();
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return (captured.ToString(), typeNames);
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
