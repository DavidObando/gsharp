// <copyright file="Issue4116VarDelegateLocalIdentityTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4116 (split from #4045's #2519 residual runtime failure,
/// <c>Issue2519SourceClassConstraintOrderingEmitTests</c>): a `var`-typed C#
/// local initialized by a delegate-creation expression
/// (<c>var handler = new Action(() =&gt; counter++);</c>) loses its nominal
/// delegate identity entirely.
/// <para>
/// <c>TranslateObjectCreation</c> unwraps <c>new SomeDelegate(lambda)</c>
/// straight to the bare lambda argument (G# has no delegate-wrapper
/// constructor to keep). An EXPLICITLY typed local (<c>Action handler =
/// ...</c>) survives this because the declared-type-preservation branch
/// (issue #4045) still emits an explicit type clause. A `var` local has no
/// such anchor, so G# was left to infer the bare arrow lambda's type from
/// its own body — and since G# models <c>++</c>/<c>--</c> as a VALUE-
/// PRODUCING expression (ADR-0115 §B / gsc issue #1027), <c>() -&gt;
/// counter++</c> naturally infers <c>Func&lt;int32&gt;</c> instead of the
/// source's <c>Action</c>. A reflection-based <c>MethodInfo.Invoke</c> against
/// the real <c>Action</c>-typed parameter then rejects it outright — "Func`1
/// passed where Action is required" — exactly
/// <c>Issue2519SourceClassConstraintOrderingEmitTests</c>' migrated-pipeline
/// failure mode.
/// </para>
/// <para>
/// The emitted annotation is the structural arrow spelling (<c>() -&gt;
/// void</c>), not the nominal name <c>Action</c>: <c>MapExplicitType</c>
/// (issue #2835/#3841/#4113/#4205) treats <c>Func</c>/<c>Action</c>/
/// <c>Predicate</c> as the structural spelling's own canonical identity and
/// still canonicalizes them, unlike a genuinely distinct nominal delegate
/// such as <c>EventHandler</c>. What matters for correctness here is only
/// that an explicit type clause exists at all, so gsc target-types the
/// lambda against it — exactly as it already does for an explicitly-typed
/// C# local (issue #4045's <c>EventHandler handler = (_, _) =&gt; hits++;</c>,
/// covered by <c>Issue4045CompilerTestsParityRegressionTests</c>) — instead
/// of inferring the lambda's type from its own body with no target at all.
/// </para>
/// </summary>
public class Issue4116VarDelegateLocalIdentityTranslationTests
{
    [Fact]
    public void VarActionLocal_FromDelegateCreationWithIncrementBody_GetsAnExplicitVoidType()
    {
        string rendered = Render(@"
using System;

namespace Corpus.Issue4116
{
    public class Holder
    {
        public Action MakeCounter(int[] box)
        {
            var handler = new Action(() => box[0]++);
            return handler;
        }
    }
}
");

        Assert.Contains("let handler () -> void = () -> box[0]++", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void VarFuncLocal_FromDelegateCreationWithIncrementBody_GetsAnExplicitReturnType()
    {
        // A non-void delegate target needs the annotation too: without it,
        // nothing is broken here (the natural inference already matches), but
        // the fix must still apply uniformly to every var-typed delegate
        // local per the shared nominal-identity rule (issue #4113/#4205),
        // not conditionally based on ReturnsVoid.
        string rendered = Render(@"
using System;

namespace Corpus.Issue4116
{
    public class Holder
    {
        public Func<int> MakeCounter(int[] box)
        {
            var handler = new Func<int>(() => box[0]++);
            return handler;
        }
    }
}
");

        Assert.Contains("let handler () -> int32 = () -> box[0]++", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void VarEventHandlerLocal_FromDelegateCreationWithIncrementBody_KeepsNominalDelegateType()
    {
        // A genuinely nominal (non-Func/Action/Predicate) delegate must keep
        // its own name, not collapse to the structural spelling — the same
        // distinction issue #4113/#4205 draws for typeof(...) operands and
        // explicit generic type arguments.
        string rendered = Render(@"
using System;

namespace Corpus.Issue4116
{
    public class Holder
    {
        public void Subscribe(int[] box)
        {
            var handler = new EventHandler((sender, args) => box[0]++);
            handler(null, EventArgs.Empty);
        }
    }
}
");

        Assert.Contains("let handler EventHandler = (", rendered, StringComparison.Ordinal);
        Assert.Contains("-> box[0]++", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void VarIntLocal_StaysUnannotated()
    {
        // Control: an ordinary non-delegate `var` local must not gain a
        // spurious type clause, so a mutant that annotates every `var` local
        // is caught here.
        string rendered = Render(@"
namespace Corpus.Issue4116
{
    public class Holder
    {
        public int Compute()
        {
            var value = 1 + 2;
            return value;
        }
    }
}
");

        Assert.Contains("let value = 1 + 2", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }
}
