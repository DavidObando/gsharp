// <copyright file="Issue4676NestedDelegateVisibilityTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4676: G# named delegates are top-level only, so cs2gs lifts a nested C#
/// delegate (<c>Outer_NameDelegate</c>). It lifted a <c>public</c> delegate nested
/// in an <c>internal</c> class as <c>public</c>, publishing four types the C#
/// GSharp.Core never exported (<c>OverloadResolver.TryBindClrConstructorCallDelegate</c>
/// and its three siblings, nested in the internal <c>OverloadResolver</c>). The
/// lifted delegate's visibility is now bounded by every type that encloses it.
/// </summary>
public class Issue4676NestedDelegateVisibilityTranslationTests
{
    private const string Source = @"
namespace Corpus.Issue4676
{
    internal sealed class OverloadResolver
    {
        public delegate bool TryBindDelegate(int syntax, out string result);

        internal delegate void InternalDelegate();

        private delegate void PrivateDelegate();
    }

    public sealed class PublicHost
    {
        public delegate bool Reachable(int x);

        internal delegate bool Friend(int x);

        private delegate bool Hidden(int x);

        protected delegate bool Derived(int x);

        protected internal delegate bool DerivedOrFriend(int x);

        public sealed class Inner
        {
            public delegate void DeepReachable();
        }
    }

    internal sealed class InternalHost
    {
        public sealed class Inner
        {
            public delegate void DeepHidden();
        }
    }

    public delegate void TopLevel();
}
";

    [Theory]
    [InlineData("OverloadResolver_TryBindDelegate", Visibility.Internal)]
    [InlineData("OverloadResolver_InternalDelegate", Visibility.Internal)]
    [InlineData("OverloadResolver_PrivateDelegate", Visibility.Internal)]
    [InlineData("PublicHost_Reachable", Visibility.Default)]
    [InlineData("PublicHost_Friend", Visibility.Internal)]
    [InlineData("PublicHost_Hidden", Visibility.Internal)]
    [InlineData("PublicHost_Derived", Visibility.Internal)]
    [InlineData("PublicHost_DerivedOrFriend", Visibility.Internal)]
    [InlineData("TopLevel", Visibility.Default)]
    public void LiftedDelegate_VisibilityIsBoundedByItsContainers(string name, Visibility expected)
    {
        // A lifted delegate has no container left to be `protected` in (a top-level
        // `protected` is GS0380), so a protected one is internal too.
        NamedDelegateDeclaration lifted = LiftedDelegates().Single(d => d.Name == name);

        Assert.Equal(expected, lifted.Visibility);
    }

    [Fact]
    public void LiftedDelegate_NestedTwoDeepInPublicTypes_StaysReachable_AndInInternalTypes_DoesNot()
    {
        var delegates = LiftedDelegates();

        Assert.Equal(
            Visibility.Default,
            delegates.Single(d => d.Name.Contains("DeepReachable", StringComparison.Ordinal)).Visibility);
        Assert.Equal(
            Visibility.Internal,
            delegates.Single(d => d.Name.Contains("DeepHidden", StringComparison.Ordinal)).Visibility);
    }

    [Fact]
    public void Rendered_InternalHostDelegate_IsNotPublic()
    {
        string rendered = GSharpPrinter.Print(Translate());

        Assert.Contains("internal delegate OverloadResolver_TryBindDelegate", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("\ndelegate OverloadResolver_TryBindDelegate", rendered, StringComparison.Ordinal);
        Assert.Contains("\ndelegate PublicHost_Reachable", rendered, StringComparison.Ordinal);
    }

    private static NamedDelegateDeclaration[] LiftedDelegates() =>
        Translate().Members.OfType<NamedDelegateDeclaration>().ToArray();

    private static CompilationUnit Translate()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Delegates.cs", Source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return new CSharpToGSharpTranslator().TranslateDocument(document, context);
    }
}
