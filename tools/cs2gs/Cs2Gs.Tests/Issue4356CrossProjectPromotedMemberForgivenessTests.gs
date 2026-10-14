// <copyright file="Issue4356CrossProjectPromotedMemberForgivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #4356 follow-up (nightly self-migration run 36076704605): a field or
/// property that cs2gs widens to `T?` in its DECLARING project, for a
/// reason only that project's source shows, must be asserted with `!!`
/// when ANOTHER project of the run reads a member through it.
///
/// Two declaration-side promotions have that shape. `[AllowNull] T P`
/// renders `T?` (#3694), and a member the declaring project compares with
/// `null` renders `T?` through the #1072 usage scan. In repository
/// mode a consumer sees its sibling through the sibling's reference assembly,
/// where neither shows: the metadata symbol has no declaring syntax, and the
/// usage evidence is in another compilation. Until gsc deleted its
/// stated-nullable carve-out (#4390) the bare chain compiled anyway. After
/// that it failed with GS0158. `src/Compiler` failed on
/// `compilation.DebugInformation.Format` and took five dependants with it,
/// and `test/Core.Tests` failed on `constructed.Definition.TypeParameters`.
open class Issue4356CrossProjectPromotedMemberForgivenessTests {
    /// The declaring project itself renders both members `T?`: the
    /// premise the consumer-side tests depend on.
    @Fact
    func DeclaringProject_RendersBothMembersNullable() {
        let (library, _) = Compile(Library, "Lib", Array.Empty[MetadataReference]())
        let printed = Translate(library, []CSharpCompilation{library})
        Assert.Contains("prop Settings Options?", printed)
        Assert.Contains("prop Definition Host?", printed)
    }

    /// The repository-mode shape: the consumer binds its sibling through the
    /// sibling's emitted image, so the members are metadata symbols. Both
    /// chains must assert the widened intermediate.
    @Fact
    func MetadataReferencedSibling_PromotedMembers_AreAsserted() {
        let (library, image) = Compile(Library, "Lib", Array.Empty[MetadataReference]())
        let (consumer, _) = Compile(Consumer, "App", []MetadataReference{image})
        let printed = Translate(consumer, []CSharpCompilation{library, consumer})
        Assert.Contains("host.Settings!!.Format", printed)
        Assert.Contains("host.Definition!!.Name", printed)
    }

    /// The same through a source-backed compilation reference.
    @Fact
    func CompilationReferencedSibling_PromotedMembers_AreAsserted() {
        let (library, _) = Compile(Library, "Lib", Array.Empty[MetadataReference]())
        let (consumer, _) = Compile(Consumer, "App", []CompilationReference{library.ToMetadataReference()})
        let printed = Translate(consumer, []CSharpCompilation{library, consumer})
        Assert.Contains("host.Settings!!.Format", printed)
        Assert.Contains("host.Definition!!.Name", printed)
    }

    /// Precision: a sibling member with no promoting evidence stays bare, so
    /// the repair does not assert every cross-project chain.
    @Fact
    func MetadataReferencedSibling_UnpromotedMember_StaysBare() {
        const consumer = `
namespace App
{
    public static class Reader
    {
        public static int Length(Lib.Host host) => host.Name.Length;
    }
}`
        let (library, image) = Compile(Library, "Lib", Array.Empty[MetadataReference]())
        let (app, _) = Compile(consumer, "App", []MetadataReference{image})
        let printed = Translate(app, []CSharpCompilation{library, app})
        Assert.Contains("host.Name.Length", printed)
        Assert.DoesNotContain("!!", printed)
    }

    /// Precision: an unconstrained generic member is judged by its DECLARED
    /// type, as the producer judges it. `Box<T>.Value` is tested with
    /// `is null` in its own project, but its type `T` is not known to
    /// be a reference type, so the producer emits it as `T`. A consumer
    /// reading `Box<string>.Value` must not assert it, whether it
    /// sees the producer as source or as metadata.
    /// @param throughMetadata Whether the consumer binds the producer's emitted image.
    @Theory
    @InlineData(true)
    @InlineData(false)
    func SubstitutedGenericMember_IsJudgedByItsDeclaredType(throughMetadata bool) {
        const box = `
namespace Lib
{
    public sealed class Box<T>
    {
        public Box(T value) { Value = value; }

        public T Value { get; }

        public bool IsEmpty => Value is null;
    }
}`
        const consumer = `
namespace App
{
    public static class Reader
    {
        public static int Length(Lib.Box<string> box) => box.Value.Length;
    }
}`
        let (library, image) = Compile(box, "Lib", Array.Empty[MetadataReference]())
        let (app, _) = Compile(
            consumer,
            "App",
            []MetadataReference{
                if throughMetadata {
                    image
                } else {
                    cast[MetadataReference](library.ToMetadataReference())
                }
            }
        )
        let producer = Translate(library, []CSharpCompilation{library, app})
        let printed = Translate(app, []CSharpCompilation{library, app})
        Assert.DoesNotContain("Value T?", producer)
        Assert.Contains("box.Value.Length", printed)
        Assert.DoesNotContain("!!", printed)
    }

    /// Precision: the declaring compilation is matched by full assembly
    /// identity. A consumer bound to a same-named assembly of ANOTHER version
    /// (a package, not this run's project) keeps that metadata's contract, so
    /// its chains stay bare even though the run's own project would widen the
    /// members.
    @Fact
    func SameNamedAssemblyOfAnotherVersion_IsNotTreatedAsTheDeclaringProject() {
        let (library, _) = Compile(Library, "Lib", Array.Empty[MetadataReference]())
        let (_, otherVersion) = Compile(
            Library.Replace(
                "using System.Diagnostics.CodeAnalysis;",
                "using System.Diagnostics.CodeAnalysis;\n[assembly: System.Reflection.AssemblyVersion(\"2.0.0.0\")]",
                StringComparison.Ordinal
            ),
            "Lib",
            Array.Empty[MetadataReference]()
        )
        let (consumer, _) = Compile(Consumer, "App", []MetadataReference{otherVersion})
        let printed = Translate(consumer, []CSharpCompilation{library, consumer})
        Assert.Contains("host.Settings.Format", printed)
        Assert.Contains("host.Definition.Name", printed)
    }

    shared {
        private const Library string = `
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

        public string Name { get; } = "host";

        public Host() { Definition = this; }

        public bool IsDefinition => Definition == null || ReferenceEquals(Definition, this);
    }
}`

        private const Consumer string = `
namespace App
{
    public static class Reader
    {
        public static int Format(Lib.Host host) => host.Settings.Format;

        public static string Name(Lib.Host host) => host.Definition.Name;
    }
}`

        private func Compile(source string, assemblyName string, references IReadOnlyList[MetadataReference])(
            Compilation CSharpCompilation,
            Image MetadataReference
        ) {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: assemblyName + ".cs"
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Concat(references),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            using let peStream = MemoryStream()
            let emit = compilation.Emit(peStream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            peStream.Position = 0
            return (compilation, MetadataReference.CreateFromStream(peStream))
        }

        private func Translate(compilation CSharpCompilation, repository IReadOnlyList[CSharpCompilation]) string {
            let tree = Assert.Single(compilation.SyntaxTrees)
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument(tree.FilePath, tree, model)
            let context = TranslationContext(
                compilation,
                model,
                document.FilePath,
                siblingCompilations: nil,
                repositoryCompilations: repository
            )
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }
    }
}
