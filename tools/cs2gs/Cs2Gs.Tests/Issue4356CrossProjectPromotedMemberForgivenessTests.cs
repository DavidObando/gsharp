// <copyright file="Issue4356CrossProjectPromotedMemberForgivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4356 follow-up (nightly self-migration run 36076704605): a field or
/// property that cs2gs widens to <c>T?</c> in its DECLARING project, for a
/// reason only that project's source shows, must be asserted with <c>!!</c>
/// when ANOTHER project of the run reads a member through it.
/// <para>
/// Two declaration-side promotions have that shape. <c>[AllowNull] T P</c>
/// renders <c>T?</c> (#3694), and a member the declaring project compares with
/// <c>null</c> renders <c>T?</c> through the #1072 usage scan. In repository
/// mode a consumer sees its sibling through the sibling's reference assembly,
/// where neither shows: the metadata symbol has no declaring syntax, and the
/// usage evidence is in another compilation. Until gsc deleted its
/// stated-nullable carve-out (#4390) the bare chain compiled anyway. After
/// that it failed with GS0158. <c>src/Compiler</c> failed on
/// <c>compilation.DebugInformation.Format</c> and took six dependants with it,
/// and <c>test/Core.Tests</c> failed on <c>constructed.Definition.TypeParameters</c>.
/// </para>
/// </summary>
public class Issue4356CrossProjectPromotedMemberForgivenessTests
{
    private const string Library = @"
using System.Diagnostics.CodeAnalysis;

namespace Lib
{
    public sealed class Options
    {
        public int Format { get; set; }
    }

    public sealed class Host
    {
        private Options options = new Options();

        [AllowNull]
        public Options Settings
        {
            get => options;
            set => options = value ?? new Options();
        }

        public Host Definition { get; }

        public string Name { get; } = ""host"";

        public Host() { Definition = this; }

        public bool IsDefinition => Definition == null || ReferenceEquals(Definition, this);
    }
}";

    private const string Consumer = @"
namespace App
{
    public static class Reader
    {
        public static int Format(Lib.Host host) => host.Settings.Format;

        public static string Name(Lib.Host host) => host.Definition.Name;
    }
}";

    /// <summary>
    /// The declaring project itself renders both members <c>T?</c>: the
    /// premise the consumer-side tests depend on.
    /// </summary>
    [Fact]
    public void DeclaringProject_RendersBothMembersNullable()
    {
        (CSharpCompilation library, _) = Compile(Library, "Lib", Array.Empty<MetadataReference>());

        string printed = Translate(library, new[] { library });

        Assert.Contains("prop Settings Options?", printed);
        Assert.Contains("prop Definition Host?", printed);
    }

    /// <summary>
    /// The repository-mode shape: the consumer binds its sibling through the
    /// sibling's emitted image, so the members are metadata symbols. Both
    /// chains must assert the widened intermediate.
    /// </summary>
    [Fact]
    public void MetadataReferencedSibling_PromotedMembers_AreAsserted()
    {
        (CSharpCompilation library, MetadataReference image) = Compile(Library, "Lib", Array.Empty<MetadataReference>());
        (CSharpCompilation consumer, _) = Compile(Consumer, "App", new[] { image });

        string printed = Translate(consumer, new[] { library, consumer });

        Assert.Contains("host.Settings!!.Format", printed);
        Assert.Contains("host.Definition!!.Name", printed);
    }

    /// <summary>
    /// The same through a source-backed compilation reference.
    /// </summary>
    [Fact]
    public void CompilationReferencedSibling_PromotedMembers_AreAsserted()
    {
        (CSharpCompilation library, _) = Compile(Library, "Lib", Array.Empty<MetadataReference>());
        (CSharpCompilation consumer, _) = Compile(Consumer, "App", new[] { library.ToMetadataReference() });

        string printed = Translate(consumer, new[] { library, consumer });

        Assert.Contains("host.Settings!!.Format", printed);
        Assert.Contains("host.Definition!!.Name", printed);
    }

    /// <summary>
    /// Precision: a sibling member with no promoting evidence stays bare, so
    /// the repair does not assert every cross-project chain.
    /// </summary>
    [Fact]
    public void MetadataReferencedSibling_UnpromotedMember_StaysBare()
    {
        const string consumer = @"
namespace App
{
    public static class Reader
    {
        public static int Length(Lib.Host host) => host.Name.Length;
    }
}";
        (CSharpCompilation library, MetadataReference image) = Compile(Library, "Lib", Array.Empty<MetadataReference>());
        (CSharpCompilation app, _) = Compile(consumer, "App", new[] { image });

        string printed = Translate(app, new[] { library, app });

        Assert.Contains("host.Name.Length", printed);
        Assert.DoesNotContain("!!", printed);
    }

    private static (CSharpCompilation Compilation, MetadataReference Image) Compile(
        string source,
        string assemblyName,
        IReadOnlyList<MetadataReference> references)
    {
        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: assemblyName + ".cs");
        CSharpCompilation compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Concat(references),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        using var peStream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult emit = compilation.Emit(peStream);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        peStream.Position = 0;
        return (compilation, MetadataReference.CreateFromStream(peStream));
    }

    private static string Translate(CSharpCompilation compilation, IReadOnlyList<CSharpCompilation> repository)
    {
        SyntaxTree tree = Assert.Single(compilation.SyntaxTrees);
        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument(tree.FilePath, tree, model);
        var context = new TranslationContext(
            compilation,
            model,
            document.FilePath,
            siblingCompilations: null,
            repositoryCompilations: repository);
        return GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }
}
