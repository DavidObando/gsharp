// <copyright file="Issue1201StaticUsingTranslationTests.cs" company="GSharp">
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
/// Issue #1201 / ADR-0134: a C# <c>using static X</c> translates to a bare type
/// import <c>import X</c>, which gsc now hoists X's <c>shared</c> (static)
/// members into scope for unqualified reference. So unlike a sibling static
/// (which is qualified through its owning type, see
/// <see cref="StaticMemberQualificationTranslationTests"/>), a member referenced
/// through a <c>using static</c> directive must be emitted UNqualified — the
/// pre-fix qualification workaround is removed.
/// </summary>
public class Issue1201StaticUsingTranslationTests
{
    private const string AuxSource = @"
namespace Corpus.Aux
{
    public static class EnumUtil
    {
        public static int[] GetValues() => new int[] { 1, 2, 3 };

        public static T[] GetValuesOf<T>(T seed) => new T[] { seed };

        public static readonly int Answer = 42;
    }
}
";

    private const string CallerSource = @"
using static Corpus.Aux.EnumUtil;

namespace Corpus.Main
{
    public class Consumer
    {
        public int[] F() => GetValues();

        public string[] G() => GetValuesOf(""x"");

        public int H() => Answer;
    }
}
";

    [Fact]
    public void UsingStatic_TranslatesTo_BareTypeImport()
    {
        string rendered = TranslateCaller();

        Assert.Contains("import Corpus.Aux.EnumUtil", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void BareStaticCall_ThroughUsingStatic_StaysUnqualified()
    {
        string rendered = TranslateCaller();

        Assert.Contains("GetValues()", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("EnumUtil.GetValues", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void BareGenericStaticCall_ThroughUsingStatic_StaysUnqualified()
    {
        string rendered = TranslateCaller();

        Assert.Contains("GetValuesOf", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("EnumUtil.GetValuesOf", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void BareStaticFieldRef_ThroughUsingStatic_StaysUnqualified()
    {
        string rendered = TranslateCaller();

        Assert.DoesNotContain("EnumUtil.Answer", rendered, StringComparison.Ordinal);
    }

    private const string CollidingAuxSource = @"
namespace Corpus.Aux
{
    public static class StubSupport
    {
        public static string File(string source) => source + ""!"";

        public static string Keep(string source) => source;

        public static T[] List<T>(T value) => new T[] { value };
    }
}
";

    // `System.IO` is used for real (`Path.GetFileName`), so its import survives
    // and `File` names an imported TYPE at file scope — the shape of
    // GSharp.GeneratorHost.Tests' `using static StubTestSupport` beside
    // `using Microsoft.CodeAnalysis`, whose `Project` type collided with the
    // imported `Project(...)` helper.
    private const string CollidingCallerSource = @"
using System.Collections.Generic;
using System.IO;
using static Corpus.Aux.StubSupport;

namespace Corpus.Main
{
    public class Consumer
    {
        public string F() => File(Path.GetFileName(""a/b""));

        public string H() => Keep(""x"");

        public string[] G() => List<string>(new List<string> { ""y"" }[0]);
    }
}
";

    /// <summary>
    /// A <c>using static</c> member whose name is also an imported type keeps
    /// its owner qualifier: gsc resolves the bare name to the TYPE, so a bare
    /// <c>File(x)</c> would bind as a conversion to <c>System.IO.File</c>
    /// (GS0155). C# picks the member in an invocation, so the translation must
    /// spell it out. (A non-invoked reference has no such case: C# itself
    /// reports CS0229 for a member-vs-type ambiguity there.) This is the nightly
    /// self-migration regression in
    /// <c>GSharp.GeneratorHost.Tests/GeneratedRegexStubTests.cs</c>.
    /// </summary>
    [Fact]
    public void UsingStaticMember_WhoseNameIsAnImportedType_IsQualified()
    {
        string rendered = Translate(CollidingAuxSource, CollidingCallerSource);

        Assert.Contains("StubSupport.File(", rendered, StringComparison.Ordinal);

        // The explicit-generic form collides with `List[T]` the same way.
        Assert.Contains("StubSupport.List[string](", rendered, StringComparison.Ordinal);

        // No collision, no qualifier: the ADR-0134 bare form is unchanged.
        Assert.Contains("Keep(\"x\")", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("StubSupport.Keep", rendered, StringComparison.Ordinal);
    }

    private const string CollidingInterfaceAuxSource = @"
namespace Corpus.Aux
{
    public interface IStubHelpers
    {
        static string File(string source) => source + ""!"";

        static T[] List<T>(T value) => new T[] { value };

        static string Keep(string source) => source;
    }
}
";

    private const string CollidingInterfaceCallerSource = @"
using System.Collections.Generic;
using System.IO;
using static Corpus.Aux.IStubHelpers;

namespace Corpus.Main
{
    public class Consumer
    {
        public string F() => File(Path.GetFileName(""a/b""));

        public string[] G() => List<string>(new List<string> { ""y"" }[0]);

        public string H() => Keep(""x"");
    }
}
";

    /// <summary>
    /// The same rule for a <c>using static</c> INTERFACE owner: C# imports an
    /// interface's concrete static methods, and G# spells them as
    /// <c>shared</c> interface members, so a colliding call keeps its
    /// qualifier in both the plain and the explicit-generic form.
    /// </summary>
    [Fact]
    public void UsingStaticInterfaceMember_WhoseNameIsAnImportedType_IsQualified()
    {
        string rendered = Translate(CollidingInterfaceAuxSource, CollidingInterfaceCallerSource);

        Assert.Contains("IStubHelpers.File(", rendered, StringComparison.Ordinal);
        Assert.Contains("IStubHelpers.List[string](", rendered, StringComparison.Ordinal);
        Assert.Contains("Keep(\"x\")", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("IStubHelpers.Keep", rendered, StringComparison.Ordinal);
    }

    private static string TranslateCaller() => Translate(AuxSource, CallerSource);

    private static string Translate(string auxSource, string callerSource)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("EnumUtil.cs", auxSource),
                ("Caller.cs", callerSource),
            });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = project.Documents.Single(d => d.FilePath.EndsWith("Caller.cs", StringComparison.Ordinal));
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
