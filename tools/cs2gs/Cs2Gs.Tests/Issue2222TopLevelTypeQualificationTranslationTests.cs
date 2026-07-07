// <copyright file="Issue2222TopLevelTypeQualificationTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
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
/// Issue #2222: two TOP-LEVEL types sharing a simple name in different
/// namespaces, both imported into the same file, must be emitted qualified
/// (<c>Namespace.Type</c>) so gsc's flat import scope binds each reference to
/// the right type instead of silently picking whichever homonym resolves
/// first (the reported GS0155/GS0158 cascade). Generalizes the #1174
/// nested-type homonym check — which only covered SOURCE-declared nested
/// types — to <c>QualifiedTypeName</c>'s top-level branch, and additionally
/// covers a homonym declared in a REFERENCED ASSEMBLY (a translated sibling
/// project surfaced as a metadata reference), not just one declared in this
/// compilation's own source.
/// </summary>
public class Issue2222TopLevelTypeQualificationTranslationTests
{
    /// <summary>
    /// Two source-declared top-level types sharing the simple name
    /// `ChapterInfo`, both imported into one file: the materialized `var`
    /// local's inferred type AND an explicitly-qualified constructor call must
    /// both round-trip fully qualified.
    /// </summary>
    [Fact]
    public void SourceHomonym_AcrossImportedNamespaces_IsEmittedQualified()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("First.cs", @"
namespace First
{
    public class ChapterInfo
    {
        public int RuntimeLengthSec;
    }
}
"),
            ("Second.cs", @"
namespace Second
{
    public class ChapterInfo
    {
        public string Asin;
    }
}
"),
            ("Caller.cs", @"
using First;
using Second;

namespace Consumer
{
    public class Book
    {
        public First.ChapterInfo ChapterInfo;
    }

    public class Caller
    {
        public void Use(Book book)
        {
            var chapterInfo = book.ChapterInfo;
            var ci = new Second.ChapterInfo();
            System.Console.WriteLine(chapterInfo.RuntimeLengthSec);
            System.Console.WriteLine(ci.Asin);
        }
    }
}
"),
        });

        Assert.True(
            project.BoundWithoutErrors,
            "Inline C# source should bind with no errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = project.Documents.Single(d => d.FilePath.EndsWith("Caller.cs", StringComparison.Ordinal));
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);

        // The `var` local's materialized type annotation is qualified...
        Assert.Contains("First.ChapterInfo", printed);

        // ...and the explicit constructor call keeps its qualification instead
        // of collapsing to the bare (ambiguous) `ChapterInfo()`.
        Assert.Contains("Second.ChapterInfo()", printed);

        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors));
    }

    /// <summary>
    /// Same simple-name collision, but the second `ChapterInfo` lives in a
    /// REFERENCED ASSEMBLY (compiled to metadata, simulating a translated
    /// sibling project) rather than in this compilation's own source. The
    /// #1174 census only ever counted source-declared types, so this is the
    /// case that needs the cross-assembly homonym check.
    /// </summary>
    [Fact]
    public void MetadataHomonym_AcrossImportedNamespaces_IsEmittedQualified()
    {
        MetadataReference libRef = CompileLibrary(
            @"
namespace Second
{
    public class ChapterInfo
    {
        public string Asin;
    }
}
",
            "Issue2222SecondLib");

        const string Source = @"
using First;
using Second;

namespace First
{
    public class ChapterInfo
    {
        public int RuntimeLengthSec;
    }
}

namespace Consumer
{
    public class Caller
    {
        public First.ChapterInfo Make()
        {
            return new First.ChapterInfo();
        }
    }
}
";

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(Source, parseOptions, path: "Caller.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2222.MetadataHomonymInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Caller.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);

        // `First.ChapterInfo` is ambiguous with the metadata `Second.ChapterInfo`
        // reachable through the file's own `using Second;` — both the return
        // type (`func Make(): First.ChapterInfo`) and the constructor call
        // (`new First.ChapterInfo()`) must be qualified. A single occurrence
        // wouldn't prove that; assert both usages so this doesn't quietly
        // regress to only qualifying one of them.
        Assert.Equal(2, CountOccurrences(printed, "First.ChapterInfo"));
        Assert.DoesNotContain(" ChapterInfo(", printed);

        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors));
    }

    /// <summary>
    /// Issue #2222 ordering blindspot: namespace <c>First</c> is reached via
    /// an explicit <c>using</c>, but the colliding namespace <c>Second</c> is
    /// reached ONLY via full qualification (<c>new Second.ChapterInfo()</c>),
    /// with NO <c>using Second;</c> anywhere in the file. Because
    /// <c>Second</c>'s namespace only enters scope as a synthesized `import`
    /// (added after the whole file is visited), an EARLIER bare reference to
    /// `ChapterInfo` from `First` must still be qualified — it cannot rely on
    /// the `using Second;` that doesn't exist to detect the collision.
    /// </summary>
    [Fact]
    public void SourceHomonym_ReachedOnlyViaFullQualification_StillQualifiesEarlierBareReference()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("First.cs", @"
namespace First
{
    public class ChapterInfo
    {
        public int RuntimeLengthSec;
    }
}
"),
            ("Second.cs", @"
namespace Second
{
    public class ChapterInfo
    {
        public string Asin;
    }
}
"),
            ("Caller.cs", @"
using First;

namespace Consumer
{
    public class Caller
    {
        public void Use()
        {
            // Bare reference to First.ChapterInfo, processed BEFORE the
            // Second.ChapterInfo reference below. No `using Second;` exists
            // anywhere in this file — Second is reached only by full
            // qualification.
            var chapterInfo = new First.ChapterInfo();
            var other = new Second.ChapterInfo();
            System.Console.WriteLine(chapterInfo.RuntimeLengthSec);
            System.Console.WriteLine(other.Asin);
        }
    }
}
"),
        });

        Assert.True(
            project.BoundWithoutErrors,
            "Inline C# source should bind with no errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = project.Documents.Single(d => d.FilePath.EndsWith("Caller.cs", StringComparison.Ordinal));
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);

        // The EARLIER reference (First.ChapterInfo) must be qualified even
        // though, at the point it's processed, no explicit `using Second;`
        // exists yet to reveal the collision.
        Assert.Contains("First.ChapterInfo()", printed);
        Assert.Contains("Second.ChapterInfo()", printed);
        Assert.DoesNotContain(" ChapterInfo(", printed);

        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors));
    }

    /// <summary>
    /// Issue #2222 low-severity fix: a `using global::Foo.Bar;` directive
    /// must be recognized the same as `using Foo.Bar;` — the `global::`
    /// alias-qualifier prefix must be stripped before the namespace name is
    /// parsed/split, or the homonym scan silently fails to match.
    /// </summary>
    [Fact]
    public void SourceHomonym_ViaGlobalQualifiedUsing_IsEmittedQualified()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("First.cs", @"
namespace First
{
    public class ChapterInfo
    {
        public int RuntimeLengthSec;
    }
}
"),
            ("Second.cs", @"
namespace Second
{
    public class ChapterInfo
    {
        public string Asin;
    }
}
"),
            ("Caller.cs", @"
using global::First;
using global::Second;

namespace Consumer
{
    public class Caller
    {
        public void Use()
        {
            var chapterInfo = new First.ChapterInfo();
            var other = new Second.ChapterInfo();
            System.Console.WriteLine(chapterInfo.RuntimeLengthSec);
            System.Console.WriteLine(other.Asin);
        }
    }
}
"),
        });

        Assert.True(
            project.BoundWithoutErrors,
            "Inline C# source should bind with no errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = project.Documents.Single(d => d.FilePath.EndsWith("Caller.cs", StringComparison.Ordinal));
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);

        Assert.Contains("First.ChapterInfo()", printed);
        Assert.Contains("Second.ChapterInfo()", printed);
        Assert.DoesNotContain(" ChapterInfo(", printed);

        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors));
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        for (int index = haystack.IndexOf(needle, StringComparison.Ordinal); index >= 0; index = haystack.IndexOf(needle, index + needle.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }

    private static MetadataReference CompileLibrary(string libSource, string assemblyName)
    {
        var libTree = CSharpSyntaxTree.ParseText(libSource, new CSharpParseOptions(LanguageVersion.Latest));
        var libCompilation = CSharpCompilation.Create(
            assemblyName,
            new[] { libTree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var peStream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult emit = libCompilation.Emit(peStream);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        peStream.Position = 0;
        return MetadataReference.CreateFromStream(peStream);
    }
}
