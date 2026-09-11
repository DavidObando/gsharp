// <copyright file="Issue4211ConditionalArmElementAccessForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for the gap PR #4211's own hot-core translation
/// guard surfaced: <c>GS0155 Cannot convert type 'GExpression?' to
/// 'GExpression'</c> compiling cs2gs's own translated
/// <c>CSharpToGSharpTranslator.Invocations.gs</c>.
/// <para>
/// Issue #2259 already bridges an element-access write whose right-hand side is
/// a promoted-nullable value (<c>arr[i] = x</c> becomes <c>arr[i] = x!!</c>),
/// because an element-access target — unlike a local/field/property/parameter —
/// has no single declaration the whole-program taint fixpoint can widen. That
/// rule asks <c>IsNullablePromotedValue</c> about the WHOLE right-hand side,
/// and for a CONDITIONAL right-hand side that question routes through
/// <c>IsNullableInitializer</c>, which recurses into the arms but reads only
/// their DECLARED annotation — the taint fixpoint's promotion is invisible to
/// it. So <c>slots[ordinal] = permutes ? this.SpillOperand(value, …) : value</c>
/// (cs2gs's own <c>TranslateClaimedLocalFunctionArgumentsWithDefaults</c>,
/// where <c>value</c> is a local the fixpoint promoted to <c>GExpression?</c>)
/// emitted a bare <c>T?</c> arm into a <c>T</c> element slot.
/// </para>
/// <para>
/// The fix answers per ARM instead — every conditional arm already translates
/// through <c>TranslateValueWithNullForgiveness</c> — so exactly the arms that
/// need the bridge get it and an already-non-null sibling arm stays byte for
/// byte unchanged.
/// </para>
/// </summary>
public class Issue4211ConditionalArmElementAccessForgivenessTranslationTests
{
    [Fact]
    public void Oblivious_PromotedTernaryArms_AssignedToArrayElement_AssertEachNullableArm()
    {
        // The reduced corpus shape: an array allocated at the parameter count,
        // filled by a loop, each slot written from a ternary whose arms carry a
        // taint-promoted local. Both arms are `Node?` here, so both are bridged.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Node
    {
        public string Name;
    }

    public class C
    {
        private Node Produce(int i)
        {
            if (i < 0)
            {
                return null;
            }

            return new Node();
        }

        private Node Spill(Node operand, int marker)
        {
            return operand;
        }

        public Node[] Run(int count, bool permute)
        {
            var slots = new Node[count];
            for (int i = 0; i < count; i++)
            {
                Node value = this.Produce(i);
                slots[i] = permute ? this.Spill(value, i) : value;
            }

            return slots;
        }
    }
}");

        Assert.Contains("slots[i] = if permute { this.Spill(value, i)!! } else { value!! }", printed);
    }

    [Fact]
    public void Oblivious_OnlyTheNullableArm_IsAsserted()
    {
        // The asymmetric half, which is what keeps this from being a blanket
        // forgiveness: the `new Node()` arm is statically non-null and must stay
        // bare, while the promoted local still needs its bridge.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Node
    {
    }

    public class C
    {
        private Node Produce(int i)
        {
            if (i < 0)
            {
                return null;
            }

            return new Node();
        }

        public Node[] Run(int count, bool permute)
        {
            var slots = new Node[count];
            for (int i = 0; i < count; i++)
            {
                Node value = this.Produce(i);
                slots[i] = permute ? new Node() : value;
            }

            return slots;
        }
    }
}");

        Assert.Contains("slots[i] = if permute { Node() } else { value!! }", printed);
    }

    [Fact]
    public void Oblivious_NestedTernaryArm_AssignedToIndexerWrite_IsAsserted()
    {
        // The sink generalizes past arrays to a user/BCL indexer write, and the
        // arm walk sees through NESTED conditionals rather than only the
        // outermost one.
        string printed = TranslateOblivious(@"
namespace Demo
{
    using System.Collections.Generic;

    public class C
    {
        private string Produce(int i)
        {
            if (i < 0)
            {
                return null;
            }

            return ""x"";
        }

        public void Run(Dictionary<string, string> sink, string key, bool a, bool b, int i)
        {
            string value = this.Produce(i);
            sink[key] = a ? (b ? value : ""lit"") : ""other"";
        }
    }
}");

        Assert.Contains(
            @"sink[key] = if a { (if b { value!! } else { ""lit"" }) } else { ""other"" }",
            printed);
    }

    [Fact]
    public void Oblivious_SwitchExpressionArm_AssignedToArrayElement_IsAsserted()
    {
        // A switch-expression arm reaches the same seam: its arm expression is
        // translated through `TranslateSwitchArmExpression` ->
        // `TranslateConditionalValueBranch` ->
        // `TranslateValueWithNullForgiveness`, exactly as a ternary arm is. The
        // corpus shape was a ternary; this pins the sibling form so the rule's
        // switch handling is exercised rather than assumed.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Node
    {
    }

    public class C
    {
        private Node Produce(int i)
        {
            if (i < 0)
            {
                return null;
            }

            return new Node();
        }

        public Node[] Run(int count, int mode)
        {
            var slots = new Node[count];
            for (int i = 0; i < count; i++)
            {
                Node value = this.Produce(i);
                slots[i] = mode switch
                {
                    0 => new Node(),
                    _ => value,
                };
            }

            return slots;
        }
    }
}");

        Assert.Contains("value!!", printed);
    }

    [Fact]
    public void Oblivious_GuardedArm_IsNotAsserted()
    {
        // gsc smart-casts a local narrowed by the conditional's own condition,
        // so the guarded arm needs no assertion — only the unguarded sibling
        // does. This is the boundary that keeps the rule from asserting values
        // the emitted G# already knows are non-null.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Node
    {
    }

    public class C
    {
        private Node Produce(int i)
        {
            if (i < 0)
            {
                return null;
            }

            return new Node();
        }

        public Node[] Run(int count)
        {
            var slots = new Node[count];
            for (int i = 0; i < count; i++)
            {
                Node value = this.Produce(i);
                Node fallback = this.Produce(0);
                slots[i] = value != null ? value : fallback;
            }

            return slots;
        }
    }
}");

        Assert.Contains("slots[i] = if value != nil { value } else { fallback!! }", printed);
    }

    [Fact]
    public void Oblivious_TernaryArmAssignedToOrdinaryLocal_IsNotAsserted()
    {
        // Only an ELEMENT-ACCESS sink qualifies. An ordinary local target is
        // widened to `T?` at its own declaration by the taint fixpoint, so the
        // arm must stay bare — asserting there would reintroduce a throw the
        // original C# never took.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Node
    {
    }

    public class C
    {
        private Node Produce(int i)
        {
            if (i < 0)
            {
                return null;
            }

            return new Node();
        }

        public Node Run(int i, bool permute)
        {
            Node value = this.Produce(i);
            Node result = null;
            result = permute ? new Node() : value;
            return result;
        }
    }
}");

        Assert.Contains("result = if permute { Node() } else { value }", printed);
        Assert.DoesNotContain("value!!", printed);
    }

    [Fact]
    public void Enabled_TernaryArmAssignedToArrayElement_IsUnchanged()
    {
        // A nullable-ENABLED compilation never runs the taint fixpoint, so this
        // rule cannot fire there: the C# compiler already checked the contract
        // and its own annotations are authoritative.
        string printed = TranslateEnabled(@"
namespace Demo
{
    public class Node
    {
    }

    public class C
    {
        public Node?[] Run(int count, bool permute, Node? value)
        {
            var slots = new Node?[count];
            for (int i = 0; i < count; i++)
            {
                slots[i] = permute ? null : value;
            }

            return slots;
        }
    }
}");

        Assert.DoesNotContain("value!!", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string TranslateEnabled(string source)
    {
        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.EnabledInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Select(r => r).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
