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
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
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
        Assert.Equal(
            MetadataMemberComparison.TypeMembers(type, module)!!,
            MetadataMemberComparison.SymbolMembers(holder)
        )
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
        Assert.Equal(
            MetadataMemberComparison.TypeMembers(type, module)!!,
            MetadataMemberComparison.SymbolMembers(option)
        )
    }

    @Fact
    func AStaticIndexedProperty_KeepsItsDeclaredParameter_AndAnEventKeepsItsRaiser() {
        // A static property that declares one parameter in its signature and in its getter, and an event with a raise method.
        let path = Path.Combine(AppContext.BaseDirectory, "csharp-fixtures", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(path)
        let file = Path.Combine(path, "Shapes5144S.dll")
        File.WriteAllBytes(file, BuildShapes())
        using let resolver = HandleResolver([]string{file})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Shapes5144S")!!
        module.TryGetDefinition("N5144S.S", out var handle)
        let shapes = module.GetTypeSymbol(handle)
        let indexer = shapes.Properties[0]
        Assert.Equal(1, indexer.Signature.Parameters.Length)
        let described = MetadataMemberComparison.DescribeProperty(indexer)
        Assert.EndsWith("|System.Int32(System.Int32)", described)
        let type = resolver.FindTypeForComparison("Shapes5144S", "N5144S.S")!!
        // Reflection reports the same single index parameter, so nothing is dropped from either side.
        Assert.Equal(
            MetadataMemberComparison.TypeMembers(type, module)!!,
            MetadataMemberComparison.SymbolMembers(shapes)
        )
        let changed = shapes.Events[0]
        Assert.False(changed.Raiser.IsNil)
        Assert.EndsWith("|2/3/4|System.Object", MetadataMemberComparison.DescribeEvent(changed))
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
    }

    @Fact
    func AVarArgMethod_KeepsItsHeader_OnBothSides() {
        using let fixture = CSharpFixture(
            "public class Logger5144V { public static void Log(int value, __arglist) {} public void Plain(int value) {} }",
            assemblyName: "VarArg5144V"
        )
        using let resolver = HandleResolver([]string{fixture.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("VarArg5144V")!!
        module.TryGetDefinition("Logger5144V", out var handle)
        let logger = module.GetTypeSymbol(handle)
        let log = logger.Methods.First((m MetadataMethodSymbol) -> m.Name == "Log")
        let plain = logger.Methods.First((m MetadataMethodSymbol) -> m.Name == "Plain")
        Assert.True(log.Signature.IsVarArg)
        Assert.False(log.Signature.HasThis)
        Assert.Equal(1, log.Signature.RequiredParameterCount)
        Assert.False(plain.Signature.IsVarArg)
        Assert.True(plain.Signature.HasThis)
        Assert.Contains("this:False/False/vararg:True", MetadataMemberComparison.DescribeMethod(log))
        Assert.Contains("this:True/False/vararg:False", MetadataMemberComparison.DescribeMethod(plain))
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
    }

    @Fact
    func FunctionPointersThatDifferOnlyInTheHeader_AreDifferentSymbols() {
        using let resolver = HandleResolver([]string{typeof(ReferenceResolver).Assembly.Location})
        let module = resolver.ImageSet!!.FindModule("System.Private.CoreLib")!!
        let plain = SignatureHeader(SignatureKind.Method, SignatureCallingConvention.Default, SignatureAttributes.None)
        let instance = SignatureHeader(
            SignatureKind.Method,
            SignatureCallingConvention.Default,
            SignatureAttributes.Instance
        )
        let explicitThis = SignatureHeader(
            SignatureKind.Method,
            SignatureCallingConvention.Default,
            SignatureAttributes.Instance | SignatureAttributes.ExplicitThis
        )
        let varArgs = SignatureHeader(
            SignatureKind.Method,
            SignatureCallingConvention.VarArgs,
            SignatureAttributes.None
        )
        let parameters = ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32, TypeSymbol.Int32)
        let set = module.Set
        let baseline = set.GetFunctionPointer(plain, 2, TypeSymbol.Void, parameters)
        Assert.Same(baseline, set.GetFunctionPointer(plain, 2, TypeSymbol.Void, parameters))
        Assert.NotSame(baseline, set.GetFunctionPointer(instance, 2, TypeSymbol.Void, parameters))
        Assert.NotSame(baseline, set.GetFunctionPointer(explicitThis, 2, TypeSymbol.Void, parameters))
        Assert.NotSame(baseline, set.GetFunctionPointer(varArgs, 2, TypeSymbol.Void, parameters))
        // The vararg boundary: the same parameter list, a different sentinel position.
        Assert.NotSame(baseline, set.GetFunctionPointer(plain, 1, TypeSymbol.Void, parameters))
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

        // Writes an assembly with one type: a static property with one declared parameter and a static getter with the same
        // parameter, and an event with add, remove and raise methods. Method rows: 1 get_Item, 2 add, 3 remove, 4 fire.
        private func BuildShapes()[]uint8 {
            let metadata = MetadataBuilder()
            metadata.AddModule(
                0,
                metadata.GetOrAddString("Shapes5144S.dll"),
                metadata.GetOrAddGuid(Guid.NewGuid()),
                GuidHandle(),
                GuidHandle()
            )
            metadata.AddAssembly(
                metadata.GetOrAddString("Shapes5144S"),
                Version(1, 0, 0, 0),
                StringHandle(),
                BlobHandle(),
                cast[AssemblyFlags](0),
                AssemblyHashAlgorithm.None
            )
            let runtime = metadata.AddAssemblyReference(
                metadata.GetOrAddString("System.Runtime"),
                Version(10, 0, 0, 0),
                StringHandle(),
                BlobHandle(),
                cast[AssemblyFlags](0),
                BlobHandle()
            )
            let objectType = metadata.AddTypeReference(
                runtime,
                metadata.GetOrAddString("System"),
                metadata.GetOrAddString("Object")
            )
            metadata.AddTypeDefinition(
                cast[TypeAttributes](0),
                StringHandle(),
                metadata.GetOrAddString("<Module>"),
                EntityHandle(),
                MetadataTokens.FieldDefinitionHandle(1),
                MetadataTokens.MethodDefinitionHandle(1)
            )
            let typeHandle = metadata.AddTypeDefinition(
                TypeAttributes.Public,
                metadata.GetOrAddString("N5144S"),
                metadata.GetOrAddString("S"),
                EntityHandle(),
                MetadataTokens.FieldDefinitionHandle(1),
                MetadataTokens.MethodDefinitionHandle(1)
            )
            let getterSignature = BlobBuilder()
            var getterReturn ReturnTypeEncoder = default(ReturnTypeEncoder)
            var getterParameters ParametersEncoder = default(ParametersEncoder)
            BlobEncoder(getterSignature).MethodSignature(SignatureCallingConvention.Default, 0, false).Parameters(
                1,
                out getterReturn,
                out getterParameters
            )
            getterReturn.Type().Int32()
            getterParameters.AddParameter().Type().Int32()
            let accessorSignature = BlobBuilder()
            var accessorReturn ReturnTypeEncoder = default(ReturnTypeEncoder)
            var accessorParameters ParametersEncoder = default(ParametersEncoder)
            BlobEncoder(accessorSignature).MethodSignature(SignatureCallingConvention.Default, 0, true).Parameters(
                1,
                out accessorReturn,
                out accessorParameters
            )
            accessorReturn.Void()
            accessorParameters.AddParameter().Type().Object()
            let getter = metadata.AddMethodDefinition(
                MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.SpecialName,
                cast[MethodImplAttributes](0),
                metadata.GetOrAddString("get_Item"),
                metadata.GetOrAddBlob(getterSignature),
                -1,
                MetadataTokens.ParameterHandle(1)
            )
            let adder = metadata.AddMethodDefinition(
                MethodAttributes.Public | MethodAttributes.SpecialName,
                cast[MethodImplAttributes](0),
                metadata.GetOrAddString("add_E"),
                metadata.GetOrAddBlob(accessorSignature),
                -1,
                MetadataTokens.ParameterHandle(1)
            )
            let remover = metadata.AddMethodDefinition(
                MethodAttributes.Public | MethodAttributes.SpecialName,
                cast[MethodImplAttributes](0),
                metadata.GetOrAddString("remove_E"),
                metadata.GetOrAddBlob(accessorSignature),
                -1,
                MetadataTokens.ParameterHandle(1)
            )
            let raiser = metadata.AddMethodDefinition(
                MethodAttributes.Public | MethodAttributes.SpecialName,
                cast[MethodImplAttributes](0),
                metadata.GetOrAddString("fire_E"),
                metadata.GetOrAddBlob(accessorSignature),
                -1,
                MetadataTokens.ParameterHandle(1)
            )
            let propertySignature = BlobBuilder()
            var propertyReturn ReturnTypeEncoder = default(ReturnTypeEncoder)
            var propertyParameters ParametersEncoder = default(ParametersEncoder)
            BlobEncoder(propertySignature).PropertySignature(false).Parameters(
                1,
                out propertyReturn,
                out propertyParameters
            )
            propertyReturn.Type().Int32()
            propertyParameters.AddParameter().Type().Int32()
            let property = metadata.AddProperty(
                cast[PropertyAttributes](0),
                metadata.GetOrAddString("Item"),
                metadata.GetOrAddBlob(propertySignature)
            )
            metadata.AddPropertyMap(typeHandle, property)
            let event_ = metadata.AddEvent(cast[EventAttributes](0), metadata.GetOrAddString("E"), objectType)
            metadata.AddEventMap(typeHandle, event_)
            metadata.AddMethodSemantics(property, MethodSemanticsAttributes.Getter, getter)
            metadata.AddMethodSemantics(event_, MethodSemanticsAttributes.Adder, adder)
            metadata.AddMethodSemantics(event_, MethodSemanticsAttributes.Remover, remover)
            metadata.AddMethodSemantics(event_, MethodSemanticsAttributes.Raiser, raiser)
            let image = BlobBuilder()
            ManagedPEBuilder(
                PEHeaderBuilder.CreateLibraryHeader(),
                MetadataRootBuilder(metadata),
                BlobBuilder()
            ).Serialize(image)
            return image.ToArray()
        }

        // The signature part of the description, from the shared spelling.
        private func MetadataModelComparison_Signature(method MetadataMethodSymbol) string {
            let described = MetadataMemberComparison.DescribeMethod(method)
            return described.Substring(described.LastIndexOf('|') + 1)
        }
    }
}
