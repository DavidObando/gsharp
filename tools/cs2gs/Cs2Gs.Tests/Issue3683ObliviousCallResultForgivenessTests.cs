// <copyright file="Issue3683ObliviousCallResultForgivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3683, family F5: a CALL RESULT whose declared return is an annotated
/// <c>T?</c> reference, read from an OBLIVIOUS file. This is the sibling of the
/// cast-receiver half (family F6, fixed in #3687) — the same
/// cross-nullable-context read through a different syntactic door.
/// <c>test/Core.Tests</c> declares no <c>Nullable</c> setting while
/// <c>src/Core</c> is annotated, so Roslyn erases the annotation at the call
/// site (the expression's type reports <c>NullableAnnotation.None</c> and the
/// flow state is <c>None</c>); none of the ordinary forgiveness predicates
/// fire, and the chained dereference reached gsc as a <c>T?</c> receiver
/// (GS0158 on a member, GS0116 on an index).
/// </summary>
public class Issue3683ObliviousCallResultForgivenessTests
{
    // Deliberately ABSTRACT members: an annotated declaration with no body can
    // seed no evidence in the whole-program taint fixpoint, so these tests
    // exercise the ANNOTATION path only and never the (already-covered)
    // oblivious promotion path.
    private const string AnnotatedDeclarations = @"
#nullable enable
using System.Threading.Tasks;

namespace Demo
{
    public abstract class Node
    {
        private Node? slot;

        public string Name { get; set; } = string.Empty;

        public abstract Node? Child();

        public abstract Node Required();

        public abstract Node[]? Children();

        public abstract Task<Node> LoadAsync();

        // Concrete on purpose: gsc has no `open prop this[...]` form yet, so an
        // abstract indexer could not be bound back by AssertBinds.
        public Node? this[int index] => this.slot;
    }
}";

    [Fact]
    public void ObliviousCallOfAnnotatedNullableReturn_MemberAccessReceiver_IsForgiven()
    {
        string printed = Translate(@"
namespace Demo
{
    public class Holder
    {
        public string Read(Node node)
        {
            return node.Child().Name;
        }
    }
}", out string declarations);

        Assert.Contains("node.Child()!!.Name", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void ObliviousCallOfAnnotatedNullableArrayReturn_ElementAccessReceiver_IsForgiven()
    {
        string printed = Translate(@"
namespace Demo
{
    public class Holder
    {
        public Node Read(Node node)
        {
            return node.Children()[0];
        }
    }
}", out string declarations);

        Assert.Contains("node.Children()!![0]", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void ObliviousReadOfAnnotatedNullableIndexer_MemberAccessReceiver_IsForgiven()
    {
        string printed = Translate(@"
namespace Demo
{
    public class Holder
    {
        public string Read(Node node)
        {
            return node[0].Name;
        }
    }
}", out string declarations);

        Assert.Contains("node[0]!!.Name", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void ObliviousCallOfNonNullableReturn_StaysUnforgiven()
    {
        string printed = Translate(@"
namespace Demo
{
    public class Holder
    {
        public string Read(Node node)
        {
            return node.Required().Name;
        }
    }
}", out string declarations);

        Assert.Contains("node.Required().Name", printed);
        Assert.DoesNotContain("Required()!!", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void ObliviousAwaitOfNonNullableTaskReturn_EnvelopeStaysUnforgiven()
    {
        // A `Task<T>` envelope is itself non-null; nothing here is annotated, so
        // the new rule must not manufacture an assertion on the awaited call.
        string printed = Translate(@"
using System.Threading.Tasks;

namespace Demo
{
    public class Holder
    {
        public async Task<string> ReadAsync(Node node)
        {
            return (await node.LoadAsync()).Name;
        }
    }
}", out _);

        Assert.DoesNotContain("LoadAsync()!!", printed);
    }

    // Returns the printed consumer file, and hands back the printed ANNOTATED
    // declarations too so callers can bind the pair with
    // <see cref="TranslationTestValidation.AssertBinds(string[])"/>.
    private static string Translate(string obliviousSource, out string printedDeclarations)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Annotated.cs", AnnotatedDeclarations), ("Oblivious.cs", obliviousSource) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join("\n", project.ErrorDiagnostics));

        printedDeclarations = Print(project, 0);
        return Print(project, 1);
    }

    private static string Print(LoadedCSharpProject project, int documentIndex)
    {
        LoadedDocument document = project.Documents[documentIndex];
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
