// <copyright file="Issue3686AnalyzerTestHarnessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Analyzers;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0169 M5 / issue #3686: an analyzer project and its TEST project must
/// translate against the SAME analyzer API. Before this, only the project
/// DECLARING an analyzer entered analyzer mode, so the migrated analyzer became
/// a <c>GSharpDiagnosticAnalyzer</c> while its migrated tests kept Roslyn's
/// <c>DiagnosticAnalyzer</c> contract, and every call site failed GS0154.
/// Covered here: the test-project detection, the harness-body rewrite onto
/// <c>GSharpAnalyzerVerifier</c> (which the C# pipeline it replaces has no
/// mapping for at all — the G# verifier takes no metadata references), and the
/// project-file half that supplies the two assemblies the migrated tests bind.
/// </summary>
public class Issue3686AnalyzerTestHarnessTests
{
    private const string AnalyzerSource = @"
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class SampleAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        ""TEST0001"",
        ""Title"",
        ""Message"",
        ""Testing"",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ElementAccessExpression);
    }

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        context.ReportDiagnostic(Diagnostic.Create(Rule, context.Node.GetLocation()));
    }
}
";

    /// <summary>
    /// The repo's own <c>AnalyzerTestHelper</c> shape, trimmed to the parts
    /// that matter: the Roslyn compilation pipeline, the metadata-reference
    /// plumbing, and the marker stripping.
    /// </summary>
    private const string HarnessSource = @"
using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample.Tests;

internal static class AnalyzerTestHelper
{
    public static async Task AssertDiagnosticsAsync(DiagnosticAnalyzer analyzer, string source, params string[] diagnosticIds)
    {
        var expectedLocations = new List<(int Line, int Column)>();
        var cleanSource = StripMarkers(source, expectedLocations);
        var tree = CSharpSyntaxTree.ParseText(cleanSource, new CSharpParseOptions(LanguageVersion.Preview));
        var compilation = CSharpCompilation.Create(
            ""AnalyzerTests"",
            new[] { tree },
            GetReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var diagnostics = await compilation.WithAnalyzers(ImmutableArray.Create(analyzer)).GetAnalyzerDiagnosticsAsync();
        if (diagnostics.Length != expectedLocations.Count)
        {
            throw new InvalidOperationException(""mismatch"");
        }
    }

    private static string StripMarkers(string source, List<(int Line, int Column)> expectedLocations)
    {
        expectedLocations.Add((1, 1));
        return source.Replace(""[|"", string.Empty).Replace(""|]"", string.Empty);
    }

    private static MetadataReference[] GetReferences()
    {
        var trusted = (string)AppContext.GetData(""TRUSTED_PLATFORM_ASSEMBLIES"");
        return trusted.Split(Path.PathSeparator).Select(p => MetadataReference.CreateFromFile(p)).ToArray();
    }
}
";

    [Fact]
    public void AnalyzerProject_IsNotItsOwnTestProject()
    {
        LoadedCSharpProject analyzer = Load(("Analyzer.cs", AnalyzerSource));

        Assert.True(AnalyzerProjectDetector.IsAnalyzerProject(analyzer.Compilation));
        Assert.False(AnalyzerProjectDetector.IsAnalyzerTestProject(analyzer.Compilation));
    }

    /// <summary>
    /// The detection this issue is about: the tests declare no analyzer, so the
    /// old "declares one" rule said false and the project translated in
    /// ordinary mode.
    /// </summary>
    [Fact]
    public void TestProject_InstantiatingAReferencedAnalyzer_IsDetected()
    {
        LoadedCSharpProject tests = Load(
            new[] { ("Harness.cs", HarnessSource), ("Tests.cs", TestsUsing("new Sample.SampleAnalyzer()")) },
            CSharpProjectLoader.RuntimeReferences().Append(CompileAnalyzerToReference()).ToList());

        Assert.False(AnalyzerProjectDetector.IsAnalyzerProject(tests.Compilation));
        Assert.True(AnalyzerProjectDetector.IsAnalyzerTestProject(tests.Compilation));
    }

    /// <summary>
    /// Anti-vacuity guard, and the real hazard of widening the detector:
    /// analyzer mode rewrites EVERY Microsoft.CodeAnalysis use in a project,
    /// so a project that merely consumes Roslyn (cs2gs itself does) must stay
    /// out of it. Only instantiating an analyzer from another assembly counts.
    /// </summary>
    [Fact]
    public void ProjectThatOnlyUsesRoslyn_IsNotAnAnalyzerTestProject()
    {
        LoadedCSharpProject plain = Load((
            "Plain.cs",
            @"
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Sample.Plain;

public static class Tool
{
    public static int Count(string source)
        => CSharpSyntaxTree.ParseText(source).GetRoot().DescendantNodes().Count();
}
"));

        Assert.False(AnalyzerProjectDetector.IsAnalyzerProject(plain.Compilation));
        Assert.False(AnalyzerProjectDetector.IsAnalyzerTestProject(plain.Compilation));
    }

    /// <summary>
    /// The harness rewrite: the signature (and therefore every call site) is
    /// preserved, the body delegates to the G# verifier, and the Roslyn
    /// compilation plumbing — which has no G# counterpart, since the G#
    /// verifier compiles G# source with no reference set — is gone rather than
    /// half-mapped. The printed G# is then bound against the real GSharp.Core
    /// and the real verifier assembly, so a signature that did not exist would
    /// fail here.
    /// </summary>
    [Fact]
    public void HarnessBody_DelegatesToTheGsharpVerifier_AndBindsAgainstGsCore()
    {
        var (printed, diagnostics) = TranslateHarness(HarnessSource);

        Assert.Contains("analyzer GSharpDiagnosticAnalyzer", printed, StringComparison.Ordinal);
        Assert.Contains(
            "GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, source, diagnosticIds)",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("import GSharp.CodeAnalysis.Analyzers.Testing", printed, StringComparison.Ordinal);

        // The Roslyn pipeline and its private plumbing are gone, not mapped.
        Assert.DoesNotContain("CSharpCompilation", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAnalyzerDiagnosticsAsync", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("MetadataReference", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("GetReferences", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("StripMarkers", printed, StringComparison.Ordinal);

        // The substitution is a declared shape adaptation, never silent.
        Assert.Contains(
            diagnostics,
            d => d.DiagnosticId == "CS2GS-ANALYZER-SHAPE" && d.Message.Contains("VerifyAnalyzer", StringComparison.Ordinal));
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);

        AssertBindsAgainstGsCore(printed);
    }

    /// <summary>
    /// The dead-code sweep is scoped: a private helper the harness shares with
    /// another member is still live after the rewrite and must survive.
    /// </summary>
    [Fact]
    public void HarnessSupportMemberUsedElsewhere_IsKept()
    {
        string shared = HarnessSource.Replace(
            "    private static MetadataReference[] GetReferences()",
            @"    public static string Normalize(string source) => StripMarkers(source, new List<(int Line, int Column)>());

    private static MetadataReference[] GetReferences()",
            StringComparison.Ordinal);

        var (printed, _) = TranslateHarness(shared);

        Assert.Contains("StripMarkers", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("GetReferences", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The project half: the migrated tests bind GSharp.Core (the analyzer API)
    /// and the verifier assembly, and — unlike an analyzer, which gsc loads
    /// beside its own copy — a test assembly must COPY both into its output.
    /// </summary>
    [Fact]
    public void AnalyzerTestProject_GetsCoreAndVerifierReferences_Copied()
    {
        XDocument transformed = TransformPair(
            testProjectXml: @"<Project Sdk=""Microsoft.NET.Sdk"">
  <ItemGroup>
    <ProjectReference Include=""..\Analyzer\Analyzer.csproj"" />
    <PackageReference Include=""Microsoft.CodeAnalysis.CSharp"" Version=""5.6.0"" />
  </ItemGroup>
</Project>");

        List<XElement> references = transformed.Descendants()
            .Where(e => e.Name.LocalName == "Reference")
            .ToList();
        Assert.Contains(references, r => r.Attribute("Include")?.Value == "GSharp.Core");
        Assert.Contains(
            references,
            r => r.Attribute("Include")?.Value == "GSharp.CodeAnalysis.Analyzers.Testing");
        Assert.All(
            references,
            r => Assert.Equal(
                "true",
                r.Elements().Single(e => e.Name.LocalName == "Private").Value));

        // The Roslyn package the harness no longer needs is dropped.
        Assert.DoesNotContain(
            transformed.Descendants().Where(e => e.Name.LocalName == "PackageReference"),
            p => p.Attribute("Include")?.Value?.StartsWith("Microsoft.CodeAnalysis", StringComparison.Ordinal) == true);
    }

    /// <summary>
    /// An analyzer's CONSUMER (the shape of src/Core: OutputItemType="Analyzer",
    /// ReferenceOutputAssembly="false") references an analyzer project to RUN
    /// it. It is ordinary C# and must keep its own Roslyn packages — mistaking
    /// it for a test project would strip them.
    /// </summary>
    [Fact]
    public void AnalyzerConsumerProject_IsNotTreatedAsATestProject()
    {
        XDocument transformed = TransformPair(
            testProjectXml: @"<Project Sdk=""Microsoft.NET.Sdk"">
  <ItemGroup>
    <ProjectReference Include=""..\Analyzer\Analyzer.csproj"" OutputItemType=""Analyzer"" ReferenceOutputAssembly=""false"" />
    <PackageReference Include=""Microsoft.CodeAnalysis.CSharp"" Version=""5.6.0"" />
  </ItemGroup>
</Project>");

        Assert.DoesNotContain(
            transformed.Descendants().Where(e => e.Name.LocalName == "Reference"),
            r => r.Attribute("Include")?.Value?.StartsWith("GSharp.", StringComparison.Ordinal) == true);
        Assert.Contains(
            transformed.Descendants().Where(e => e.Name.LocalName == "PackageReference"),
            p => p.Attribute("Include")?.Value == "Microsoft.CodeAnalysis.CSharp");
    }

    private static string TestsUsing(string construction) => @"
namespace Sample.Tests.Cases;

public sealed class SampleAnalyzerTests
{
    public System.Threading.Tasks.Task Reports()
        => Sample.Tests.AnalyzerTestHelper.AssertDiagnosticsAsync(" + construction + @", ""class C { }"", ""TEST0001"");
}
";

    private static LoadedCSharpProject Load((string FileName, string Source) source)
        => Load(new[] { source }, references: null);

    private static LoadedCSharpProject Load(
        (string FileName, string Source)[] sources,
        IReadOnlyList<MetadataReference> references)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(sources, references);
        Assert.True(
            project.BoundWithoutErrors,
            "Fixture should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));
        return project;
    }

    private static MetadataReference CompileAnalyzerToReference()
    {
        LoadedCSharpProject analyzer = Load(("Analyzer.cs", AnalyzerSource));
        using var stream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult result = analyzer.Compilation.Emit(stream);
        Assert.True(
            result.Success,
            "Analyzer fixture should emit: " + string.Join(Environment.NewLine, result.Diagnostics));
        return MetadataReference.CreateFromImage(stream.ToArray());
    }

    private static (string Printed, IReadOnlyList<TranslationDiagnostic> Diagnostics) TranslateHarness(string harnessSource)
    {
        LoadedCSharpProject project = Load(("Harness.cs", harnessSource));
        var translator = new CSharpToGSharpTranslator(analyzerApiMode: true);
        LoadedDocument document = project.Documents.Single(d => Path.GetFileName(d.FilePath) == "Harness.cs");
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = translator.TranslateDocument(document, context);
        return (GSharpPrinter.Print(unit), context.Diagnostics);
    }

    private static void AssertBindsAgainstGsCore(string printed)
    {
        // Issue #3734/#3767: a translated analyzer's references have all been
        // retargeted onto the G# analyzer API, so it must import G# namespaces
        // only — a residual `import Microsoft.CodeAnalysis` would make bare
        // `Diagnostic`/`SyntaxKind` bind by import order.
        Assert.DoesNotContain("import Microsoft.", printed, StringComparison.Ordinal);

        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From(printed, "harness.gs"));
        Assert.True(
            tree.Diagnostics.IsEmpty,
            "Translated harness should parse cleanly:\n"
                + string.Join("\n", tree.Diagnostics.Select(d => d.Message)) + "\n---\n" + printed);

        string[] referencePaths =
        {
            typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location,
            typeof(GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier).Assembly.Location,
        };
        using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(referencePaths);
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, tree)
        {
            IsLibrary = true,
        };
        var errors = compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .ToList();
        Assert.True(
            errors.Count == 0,
            "Translated harness should bind against GSharp.Core and the verifier:\n"
                + string.Join("\n", errors.Select(d => d.Message)) + "\n---\n" + printed);
    }

    private static XDocument TransformPair(string testProjectXml)
    {
        string root = Path.Combine(Path.GetTempPath(), "cs2gs-3686-" + Guid.NewGuid().ToString("N"));
        try
        {
            string analyzerDirectory = Path.Combine(root, "Analyzer");
            string testDirectory = Path.Combine(root, "Analyzer.Tests");
            Directory.CreateDirectory(analyzerDirectory);
            Directory.CreateDirectory(testDirectory);

            File.WriteAllText(
                Path.Combine(analyzerDirectory, "Analyzer.csproj"),
                @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
  </PropertyGroup>
</Project>");

            string testProjectPath = Path.Combine(testDirectory, "Analyzer.Tests.csproj");
            File.WriteAllText(testProjectPath, testProjectXml);

            return Cs2Gs.Pipeline.GSharpProjectTransformer.Transform(
                testProjectPath,
                testDirectory,
                "Gsharp.NET.Sdk/1.0.0",
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase));
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }
}
