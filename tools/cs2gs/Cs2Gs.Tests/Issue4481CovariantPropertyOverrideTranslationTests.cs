// <copyright file="Issue4481CovariantPropertyOverrideTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4481: a C# covariant get-only override,
/// <c>public override PropertySymbol Property { get; }</c> over
/// <c>public abstract Symbol? Property { get; }</c> (the #4441 shape in
/// <c>BoundPropertyAccessExpression</c>), translates to a narrowed
/// <c>override prop</c> whose migrated type LOADS: gsc used to emit its getter
/// without binding it to the base slot, so reading the property threw a
/// TypeLoadException ("get_Property ... does not have an implementation").
/// </summary>
public class Issue4481CovariantPropertyOverrideTranslationTests
{
    [Fact]
    public void CovariantGetOnlyOverride_TranslatesAndLoads()
    {
        string printed = Render(@"
namespace Corpus.Issue4481
{
    public class Sym
    {
        public Sym(string name) { Name = name; }

        public string Name { get; }
    }

    public sealed class PSym : Sym
    {
        public PSym(string name) : base(name) { }

        public string Tag => ""p:"" + Name;
    }

    public abstract class Node
    {
        public abstract Sym? Property { get; }
    }

    public sealed class Access : Node
    {
        public Access(PSym property) { Property = property; }

        public override PSym Property { get; }
    }

    public sealed class Same : Node
    {
        public Same(Sym property) { Property = property; }

        public override Sym? Property { get; }
    }

    public class Probe
    {
        public static string Run()
        {
            Node access = new Access(new PSym(""x""));
            Node same = new Same(new Sym(""y""));
            var direct = new Access(new PSym(""z""));
            return access.Property!.Name + "","" + same.Property!.Name + "","" + direct.Property.Tag;
        }
    }
}
");

        // The override keeps its narrowed type, so a derived-typed read still
        // sees `PSym` members.
        Assert.Matches(@"override prop Property PSym\b", printed);
        Assert.True(TranslationTestValidation.AssertBinds(printed).Success);

        var result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal("x,y,p:z", result.Value);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Source.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity is TranslationSeverity.Unsupported or TranslationSeverity.Warning);
        return printed;
    }
}
