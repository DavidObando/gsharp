// <copyright file="Issue5144MemberSymbolTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import AssemblyIdentity = GSharp.Core.CodeAnalysis.Symbols.AssemblyIdentity
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Threading.Tasks
import Xunit

/// ADR-0209 PR 2c-i (#5144): member symbols (methods, fields, properties, events), compared with the context on
/// identity, flags and signatures (questions Q6 to Q10). The expected texts are written out, not computed by the product.
open class Issue5144MemberSymbolTests {
    @Fact
    func TheMembersOfAFixture_HaveTheExpectedShape() {
        using let fixture = CSharpFixture(
            "using System; namespace N5144X { public class Widget { public const int Limit = 3; public static readonly string Name = \"w\"; public int Count; public Widget(int count) { Count = count; } public void Move(int x, ref int y, out int z, string label = \"a\") { z = 0; } public T Pick<T>(T first) where T : class, new() { return first; } public int this[int index] { get { return index; } set { } } public string Title { get; private set; } public event EventHandler Changed; } }",
            assemblyName: "Members5144X"
        )
        using let resolver = HandleResolver([]string{fixture.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Members5144X")!!
        module.TryGetDefinition("N5144X.Widget", out var handle)
        let widget = module.GetTypeSymbol(handle)
        // Table order, constructors with the methods.
        Assert.Equal(
            []string{
                ".ctor",
                "Move",
                "Pick",
                "get_Item",
                "set_Item",
                "get_Title",
                "set_Title",
                "add_Changed",
                "remove_Changed",
                ".cctor"
            },
            widget.Methods.Select((m MetadataMethodSymbol) -> m.Name).ToArray()
        )
        Assert.Equal(
            []string{"Limit", "Name", "Count", "<Title>k__BackingField", "Changed"},
            widget.Fields.Select((f MetadataFieldSymbol) -> f.Name).ToArray()
        )
        Assert.Equal(
            []string{"Item", "Title"},
            widget.Properties.Select((p MetadataPropertySymbol) -> p.Name).ToArray()
        )
        Assert.Equal([]string{"Changed"}, widget.Events.Select((e MetadataEventSymbol) -> e.Name).ToArray())
        let move = widget.Methods[1]
        Assert.Equal(
            "System.Void(x:0:System.Int32;y:0:System.Int32&;z:2:System.Int32&;label:4112:System.String)",
            MetadataModelComparison_Signature(move)
        )
        Assert.True(move.Signature.HasThis)
        let pick = widget.Methods[2]
        Assert.Equal(1, pick.GenericParameters.Parameters.Length)
        Assert.True(pick.GenericParameters.Parameters[0].IsMethodTypeParameter)
        Assert.True(pick.GenericParameters.Parameters[0].HasReferenceTypeConstraint)
        Assert.True(pick.GenericParameters.Parameters[0].HasDefaultConstructorConstraint)
        // The method's own parameter is !!0 in its signature.
        Assert.Equal("!!0", MetadataTypeKeys.Of(pick.Signature.ReturnType))
        // A literal field keeps its attribute bits; the type of a field is decoded.
        Assert.True((widget.Fields[0].Flags & FieldAttributes.Literal) != 0)
        Assert.Equal("System.String", MetadataTypeKeys.Of(widget.Fields[1].FieldType))
        // Accessors come from MethodSemantics: the indexer has both, Title has a private setter.
        let indexer = widget.Properties[0]
        Assert.False(indexer.Getter.IsNil)
        Assert.False(indexer.Setter.IsNil)
        Assert.Equal("System.Int32", MetadataTypeKeys.Of(indexer.Signature.ReturnType))
        Assert.Equal(1, indexer.Signature.Parameters.Length)
        Assert.False(widget.Events[0].Adder.IsNil)
        Assert.False(widget.Events[0].Remover.IsNil)
        Assert.Equal("System.Private.CoreLib!System.EventHandler", MetadataTypeKeys.Of(widget.Events[0].HandlerType))
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
    }

    @Fact
    func AMissingTypeInOneSignature_NormalizesThatMemberOnly() {
        using let lib = CSharpFixture("namespace N5144Y { public class Gone {} }", assemblyName: "GoneY5144")
        using let user = CSharpFixture(
            "public class Holder5144Y { public void Broken(N5144Y.Gone g) {} public void Fine(int x) {} public N5144Y.Gone Field; public int Other; }",
            []Microsoft
                .CodeAnalysis
                .MetadataReference{Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(lib.AssemblyPath)},
            assemblyName: "Holder5144Y"
        )
        using let resolver = HandleResolver([]string{user.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Holder5144Y")!!
        module.TryGetDefinition("Holder5144Y", out var handle)
        let holder = module.GetTypeSymbol(handle)
        let broken = MetadataMemberComparison.DescribeMethod(
            holder.Methods.First((m MetadataMethodSymbol) -> m.Name == "Broken")
        )
        let fine = MetadataMemberComparison.DescribeMethod(
            holder.Methods.First((m MetadataMethodSymbol) -> m.Name == "Fine")
        )
        Assert.EndsWith("|signature-missing", broken)
        Assert.EndsWith("|System.Void(x:0:System.Int32)", fine)
        Assert.EndsWith("|signature-missing", MetadataMemberComparison.DescribeField(holder.Fields[0]))
        Assert.EndsWith("|System.Int32", MetadataMemberComparison.DescribeField(holder.Fields[1]))
        // The context reaches the same descriptions, member by member.
        let type = resolver.FindTypeForComparison("Holder5144Y", "Holder5144Y")!!
        Assert.Equal(MetadataMemberComparison.TypeMembers(type)!!, MetadataMemberComparison.SymbolMembers(holder))
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
    }

    @Fact
    func AStaticAccessorWithAnArgument_IsNotAnIndexParameter() {
        // F# emits `static member get_IsNone(option)` for a property. The table signature has no parameter, and
        // reflection reports the accessor's argument as an index parameter. The comparison follows the table.
        let path = Path.Combine(AppContext.BaseDirectory, "FSharp.Core.dll")
        Assert.True(File.Exists(path), path)
        using let resolver = HandleResolver([]string{path})
        let set = resolver.ImageSet!!
        let module = set.FindModule("FSharp.Core")!!
        module.TryGetDefinition("Microsoft.FSharp.Core.FSharpOption`1", out var handle)
        let option = module.GetTypeSymbol(handle)
        let isNone = option.Properties.First((p MetadataPropertySymbol) -> p.Name == "IsNone")
        Assert.Empty(isNone.Signature.Parameters)
        let described = MetadataMemberComparison.DescribeProperty(isNone)
        Assert.EndsWith("|System.Boolean()", described)
        let type = resolver.FindTypeForComparison("FSharp.Core", "Microsoft.FSharp.Core.FSharpOption`1")!!
        Assert.Equal(MetadataMemberComparison.TypeMembers(type)!!, MetadataMemberComparison.SymbolMembers(option))
    }

    @Fact
    func OneSymbolForOneMemberRow_EvenWhenManyThreadsAsk() {
        using let resolver = HandleResolver([]string{typeof(ReferenceResolver).Assembly.Location})
        let module = resolver.ImageSet!!.FindModule("System.Private.CoreLib")!!
        module.TryGetDefinition("System.String", out var handle)
        let methodHandle = module.Reader.GetTypeDefinition(handle).GetMethods().First()
        let seen = System.Collections.Concurrent.ConcurrentBag[MetadataMethodSymbol]()
        Parallel.For(0, 64, (i int32) -> seen.Add(module.GetMethodSymbol(methodHandle)))
        Assert.Equal(1, seen.Distinct().Count())
    }

    @Fact
    func AFunctionPointer_IsInternedByItsSignatureAndKeysByShape() {
        using let resolver = HandleResolver([]string{typeof(ReferenceResolver).Assembly.Location})
        let module = resolver.ImageSet!!.FindModule("System.Private.CoreLib")!!
        let header = SignatureHeader(cast[uint8](SignatureKind.Method))
        let first = module.Decoder.GetFunctionPointerType(
            MethodSignature[TypeSymbol](
                header,
                TypeSymbol.Void,
                1,
                0,
                ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
            )
        )
        let second = module.Decoder.GetFunctionPointerType(
            MethodSignature[TypeSymbol](
                header,
                TypeSymbol.Void,
                1,
                0,
                ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
            )
        )
        let other = module.Decoder.GetFunctionPointerType(
            MethodSignature[TypeSymbol](
                header,
                TypeSymbol.Void,
                1,
                0,
                ImmutableArray.Create[TypeSymbol](TypeSymbol.Int64)
            )
        )
        Assert.Same(first, second)
        Assert.NotSame(first, other)
        Assert.Equal("fnptr(System.Void;System.Int32)", MetadataTypeKeys.Of(first))
    }

    @Fact
    func TypedReference_IsTheDefinitionTheSetSupplies_OrAMissingType() {
        using let resolver = HandleResolver([]string{typeof(ReferenceResolver).Assembly.Location})
        let module = resolver.ImageSet!!.FindModule("System.Private.CoreLib")!!
        let supplied = module.Decoder.GetPrimitiveType(PrimitiveTypeCode.TypedReference)
        Assert.IsType[MetadataTypeSymbol](supplied)
        Assert.Equal("System.Private.CoreLib!System.TypedReference", MetadataTypeKeys.Of(supplied))
        // A set without a core library cannot supply it.
        using let fixture = CSharpFixture("public class Alone5144Z {}", assemblyName: "Alone5144Z")
        let bare = ReferenceImageSet(
            ImmutableArray.Create(ReferenceImage(File.ReadAllBytes(fixture.AssemblyPath), fixture.AssemblyPath, true))
        )
        Assert.IsType[MissingTypeSymbol](bare.Modules[0].Decoder.GetPrimitiveType(PrimitiveTypeCode.TypedReference))
    }

    shared {
        private func HandleResolver(paths[]string) ReferenceResolver {
            using let override_ = MetadataModel.Override(MetadataModelMode.Handles)
            return ReferenceResolver.WithReferences(paths)
        }

        // The signature part of the description, from the shared spelling.
        private func MetadataModelComparison_Signature(method MetadataMethodSymbol) string {
            let described = MetadataMemberComparison.DescribeMethod(method)
            return described.Substring(described.LastIndexOf('|') + 1)
        }
    }
}
