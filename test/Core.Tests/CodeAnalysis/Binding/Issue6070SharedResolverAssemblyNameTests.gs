// <copyright file="Issue6070SharedResolverAssemblyNameTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// Issue #6070: sharing one (cref:ReferenceResolver) across compilations with different
/// (cref:Compilation.AssemblyName) values must isolate `InternalsVisibleTo` visibility,
/// type resolution caches, and semantic aggregates per consumer assembly name.
class Issue6070SharedResolverAssemblyNameTests {
    @Fact
    func InterleavedCompilation_FriendThenStranger_PreservesFriendInternalAccessAndExecutes() {
        using let fixture = CSharpFixture(SharedLibrarySource)
        let source = `package Probe
import Lib

func Use() int32 {
    let bag = Api.Create()
    return Api.Secret() + bag.HiddenMethod() + bag.HiddenProp + bag.HiddenField + bag.HiddenExt() + SecretType.Value()
}
`
        using let shared = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let friend = Compilation(shared, SyntaxTree.Parse(SourceText.From(source, "friend.gs"))){
            AssemblyName = "Friend"
        }
        // Declaration bind of Friend, then Stranger is created and binds declarations before Friend binds bodies.
        let _ = friend.GlobalScope
        let stranger = Compilation(shared, SyntaxTree.Parse(SourceText.From(source, "stranger.gs"))){
            AssemblyName = "Stranger"
        }
        let _ = stranger.GlobalScope
        let friendDiagnostics = friend.GetDiagnostics()
        Assert.Empty(friendDiagnostics.Where((d Diagnostic) -> d.IsError))
        using let pe = MemoryStream()
        let emitResult = friend.Emit(pe, nil, nil, assemblyName: "Friend")
        Assert.True(emitResult.Success, Describe(emitResult.Diagnostics))
        Assert.Equal(
            42 + 10 + 20 + 30 + 40 + 50,
            InvokeRunMethod(pe.ToArray(), fixture.AssemblyPath, "Probe.<Program>", "Use")
        )
    }

    @Theory
    @InlineData(`package Probe
import Lib
func Use() int32 -> Api.Secret()`, "GS0159")
    @InlineData(`package Probe
import Lib
func Use() int32 {
    let bag = Api.Create()
    return bag.HiddenMethod()
}`, "GS0159")
    @InlineData(`package Probe
import Lib
func Use() int32 {
    let bag = Api.Create()
    return bag.HiddenProp
}`, "GS0158")
    @InlineData(`package Probe
import Lib
func Use() int32 {
    let bag = Api.Create()
    return bag.HiddenField
}`, "GS0158")
    @InlineData(`package Probe
import Lib
func Use() int32 {
    let bag = Api.Create()
    return bag.HiddenExt()
}`, "GS0159")
    @InlineData(`package Probe
import Lib
func Use() int32 -> SecretType.Value()`, "GS0157")
    func InterleavedCompilation_StrangerThenFriend_RejectsStrangerInternalAccess(
        source string,
        expectedErrorId string
    ) {
        using let fixture = CSharpFixture(SharedLibrarySource)
        using let shared = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let stranger = Compilation(shared, SyntaxTree.Parse(SourceText.From(source, "stranger.gs"))){
            AssemblyName = "Stranger"
        }
        // Declaration bind of Stranger, then Friend is created and binds declarations before Stranger binds bodies.
        let _ = stranger.GlobalScope
        let friend = Compilation(shared, SyntaxTree.Parse(SourceText.From(source, "friend.gs"))){
            AssemblyName = "Friend"
        }
        let _ = friend.GlobalScope
        let strangerErrors = stranger.GetDiagnostics().Where((d Diagnostic) -> d.IsError).ToArray()
        Assert.NotEmpty(strangerErrors)
        Assert.Contains(strangerErrors, (d Diagnostic) -> d.Id == expectedErrorId)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func SharedResolver_DuplicateTypeNameAcrossInternalAndPublicAssemblies_ResolvesPerConsumer(friendFirst bool) {
        using let internalLib = CSharpFixture(`using System.Runtime.CompilerServices;
[assembly: InternalsVisibleTo("Friend")]
namespace DupNs {
    internal static class SharedName {
        internal static int Pick() => 11;
    }
}`, assemblyName: "DupInternal")
        using let publicLib = CSharpFixture(`namespace DupNs {
    public static class SharedName {
        public static int Pick() => 22;
    }
}`, assemblyName: "DupPublic")
        let source = `package Probe
import DupNs
func Use() int32 -> SharedName.Pick()
`
        using let shared = ReferenceResolver.WithReferences([]string{internalLib.AssemblyPath, publicLib.AssemblyPath})
        let friend = Compilation(shared, SyntaxTree.Parse(SourceText.From(source, "friend.gs"))){
            AssemblyName = "Friend"
        }
        let stranger = Compilation(shared, SyntaxTree.Parse(SourceText.From(source, "stranger.gs"))){
            AssemblyName = "Stranger"
        }
        if friendFirst {
            let _ = friend.GlobalScope
            let _ = stranger.GlobalScope
        } else {
            let _ = stranger.GlobalScope
            let _ = friend.GlobalScope
        }
        using let friendPe = MemoryStream()
        let friendEmit = friend.Emit(friendPe, nil, nil, assemblyName: "Friend")
        Assert.True(friendEmit.Success, Describe(friendEmit.Diagnostics))
        Assert.Equal(11, InvokeRunMethod(friendPe.ToArray(), internalLib.AssemblyPath, "Probe.<Program>", "Use"))

        using let strangerPe = MemoryStream()
        let strangerEmit = stranger.Emit(strangerPe, nil, nil, assemblyName: "Stranger")
        Assert.True(strangerEmit.Success, Describe(strangerEmit.Diagnostics))
        Assert.Equal(22, InvokeRunMethod(strangerPe.ToArray(), publicLib.AssemblyPath, "Probe.<Program>", "Use"))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func SharedResolver_SemanticAggregateCache_IsolatesInternalMembersByConsumerAssemblyName(friendFirst bool) {
        using let fixture = CSharpFixture(`using System.Runtime.CompilerServices;
[assembly: InternalsVisibleTo("Friend")]
namespace RecordLib {
    public record SecretRecord(int PublicVal) {
        internal int SecretProp => 42;
        internal int SecretMethod() => 99;
    }
}`)
        let source = `package Probe
import RecordLib
func Use() int32 {
    let r = SecretRecord{PublicVal: 7}
    return r.PublicVal + r.SecretProp + r.SecretMethod()
}
`
        using let shared = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let friend = Compilation(shared, SyntaxTree.Parse(SourceText.From(source, "friend.gs"))){
            AssemblyName = "Friend"
        }
        let stranger = Compilation(shared, SyntaxTree.Parse(SourceText.From(source, "stranger.gs"))){
            AssemblyName = "Stranger"
        }
        if friendFirst {
            let friendResult = friend.GetDiagnostics()
            Assert.Empty(friendResult.Where((d Diagnostic) -> d.IsError))
            let strangerErrors = stranger.GetDiagnostics().Where((d Diagnostic) -> d.IsError).ToArray()
            Assert.NotEmpty(strangerErrors)
            Assert.Contains(strangerErrors, (d Diagnostic) -> d.Id == "GS0158" || d.Id == "GS0159")
        } else {
            let strangerErrors = stranger.GetDiagnostics().Where((d Diagnostic) -> d.IsError).ToArray()
            Assert.NotEmpty(strangerErrors)
            Assert.Contains(strangerErrors, (d Diagnostic) -> d.Id == "GS0158" || d.Id == "GS0159")
            let friendResult = friend.GetDiagnostics()
            Assert.Empty(friendResult.Where((d Diagnostic) -> d.IsError))
        }
        using let pe = MemoryStream()
        let emitResult = friend.Emit(pe, nil, nil, assemblyName: "Friend")
        Assert.True(emitResult.Success, Describe(emitResult.Diagnostics))
        Assert.Equal(7 + 42 + 99, InvokeRunMethod(pe.ToArray(), fixture.AssemblyPath, "Probe.<Program>", "Use"))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func SharedResolver_InternalOverrideOfImportedBase_IsolatesPerConsumerAssemblyName(friendFirst bool) {
        using let fixture = CSharpFixture(`using System.Runtime.CompilerServices;
[assembly: InternalsVisibleTo("Friend")]
namespace OverrideLib {
    public class BaseType {
        internal virtual int Compute() => 1;
    }
}`)
        let source = `package Probe
import OverrideLib
class Derived : BaseType {
    internal override func Compute() int32 -> 2
}
func Use() int32 -> Derived().Compute()
`
        using let shared = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let friend = Compilation(shared, SyntaxTree.Parse(SourceText.From(source, "friend.gs"))){
            AssemblyName = "Friend"
        }
        let stranger = Compilation(shared, SyntaxTree.Parse(SourceText.From(source, "stranger.gs"))){
            AssemblyName = "Stranger"
        }
        if friendFirst {
            let _ = friend.GlobalScope
            let _ = stranger.GlobalScope
        } else {
            let _ = stranger.GlobalScope
            let _ = friend.GlobalScope
        }
        Assert.Empty(friend.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        let strangerErrors = stranger.GetDiagnostics().Where((d Diagnostic) -> d.IsError).ToArray()
        Assert.NotEmpty(strangerErrors)

        // Interleave Stranger construction before Friend binds declarations so mutable resolver state would flip Friend.
        using let interleaved = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let interleavedFriend = Compilation(interleaved, SyntaxTree.Parse(SourceText.From(source, "ifriend.gs"))){
            AssemblyName = "Friend"
        }
        let interleavedStranger = Compilation(interleaved, SyntaxTree.Parse(SourceText.From(source, "istranger.gs"))){
            AssemblyName = "Stranger"
        }
        Assert.Empty(interleavedFriend.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        Assert.NotEmpty(interleavedStranger.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func SharedResolver_FriendVisibleTypeShadowsNativeAlias_WithoutMutatingResolver() {
        using let fixture = CSharpFixture(`using System.Runtime.CompilerServices;
[assembly: InternalsVisibleTo("Friend")]
namespace AliasLib {
    internal class slice<T> {
        public T Value;
        public slice(T v) { Value = v; }
    }
}`)
        let source = `package Probe
import AliasLib
func Use() int32 {
    let s = slice[int32](42)
    return s.Value
}
`
        using let shared = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let friend = Compilation(shared, SyntaxTree.Parse(SourceText.From(source, "friend.gs"))){
            AssemblyName = "Friend"
        }
        let stranger = Compilation(shared, SyntaxTree.Parse(SourceText.From(source, "stranger.gs"))){
            AssemblyName = "Stranger"
        }
        Assert.Empty(friend.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        using let pe = MemoryStream()
        let emitResult = friend.Emit(pe, nil, nil, assemblyName: "Friend")
        Assert.True(emitResult.Success, Describe(emitResult.Diagnostics))
        Assert.Equal(42, InvokeRunMethod(pe.ToArray(), fixture.AssemblyPath, "Probe.<Program>", "Use"))
        Assert.NotEmpty(stranger.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func EmitWithoutRepeatingAssemblyName_PreservesFriendCopyConstructorThroughLowering() {
        using let fixture = CSharpFixture(`using System.Runtime.CompilerServices;
[assembly: InternalsVisibleTo("Friend")]
namespace BaseCopyLib {
    public class BaseRec {
        public BaseRec() {}
        internal BaseRec(BaseRec other) {}
    }
}`)
        let source = `package Probe
import BaseCopyLib
data class Derived(X int32) : BaseRec
func Capture(v int32) int32 {
    var x = v
    let f = () -> x
    let msg = "v=$v"
    return f() + msg.Length
}
`
        using let shared = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let friend = Compilation(shared, SyntaxTree.Parse(SourceText.From(source, "friend.gs"))){
            AssemblyName = "Friend"
        }
        using let pe = MemoryStream()
        let emitResult = friend.Emit(pe)
        Assert.True(emitResult.Success, Describe(emitResult.Diagnostics))
    }

    @Fact
    func SharedResolver_EmitBoundInternalAttribute_PreservesFriendAssemblyIdentity() {
        using let internalAttr = CSharpFixture(`using System;
using System.Runtime.CompilerServices;
[assembly: InternalsVisibleTo("Friend")]
namespace AttrNs {
    [AttributeUsage(AttributeTargets.Class)]
    internal sealed class MarkerAttribute : Attribute {
        public MarkerAttribute(int code) {}
    }
}`, assemblyName: "AttrInternal")
        using let publicAttr = CSharpFixture(`using System;
namespace AttrNs {
    [AttributeUsage(AttributeTargets.Class)]
    public sealed class MarkerAttribute : Attribute {
        public MarkerAttribute(string label) {}
    }
}`, assemblyName: "AttrPublic")
        let source = `package Probe
import AttrNs
@Marker(7)
public class Tagged {}
`
        using let shared = ReferenceResolver.WithReferences(
            []string{internalAttr.AssemblyPath, publicAttr.AssemblyPath}
        )
        let friend = Compilation(shared, SyntaxTree.Parse(SourceText.From(source, "friend.gs"))){
            AssemblyName = "Friend"
        }
        using let pe = MemoryStream()
        let emitResult = friend.Emit(pe)
        Assert.True(emitResult.Success, Describe(emitResult.Diagnostics))
        pe.Position = 0
        using let reader = PEReader(pe)
        let md = reader.GetMetadataReader()
        let tagged = md
            .TypeDefinitions
            .Select((h TypeDefinitionHandle) -> md.GetTypeDefinition(h))
            .Single((td TypeDefinition) -> md.GetString(td.Name) == "Tagged")
        let attrAssemblies = tagged
            .GetCustomAttributes()
            .Select(
            (h CustomAttributeHandle) -> {
                let attr = md.GetCustomAttribute(h)
                let mr = md.GetMemberReference(cast[MemberReferenceHandle](attr.Constructor))
                let tr = md.GetTypeReference(cast[TypeReferenceHandle](mr.Parent))
                return (
                    Assembly: md.GetString(
                        md.GetAssemblyReference(cast[AssemblyReferenceHandle](tr.ResolutionScope)).Name
                    ),
                    Name: md.GetString(tr.Name)
                )
            }
        )
            .Where((entry(Assembly string, Name string)) -> entry.Name == "MarkerAttribute")
            .ToArray()
        let emittedAttr = Assert.Single(attrAssemblies)
        Assert.Equal("AttrInternal", emittedAttr.Assembly)
    }

    @Fact
    func SharedResolver_DuplicateTypeInGenericArgAndDelegateParam_PreservesConsumerIdentity() {
        using let internalLib = CSharpFixture(`using System.Runtime.CompilerServices;
[assembly: InternalsVisibleTo("Friend")]
namespace DupGeneric {
    internal class Item {
        public int Id => 7;
    }
}`, assemblyName: "DupGenericInternal")
        using let publicLib = CSharpFixture(`namespace DupGeneric {
    public class Item {
        public string Label => "pub";
    }
}`, assemblyName: "DupGenericPublic")
        let friendSource = `package Probe
import DupGeneric
import System.Collections.Generic
func Use(cb (Item) -> int32) int32 {
    let list = List[Item]()
    list.Add(Item())
    return cb(list[0]) + list[0].Id
}
`
        let strangerSource = `package Probe
import DupGeneric
import System.Collections.Generic
func Use(cb (Item) -> string) string {
    let list = List[Item]()
    list.Add(Item())
    return cb(list[0]) + list[0].Label
}
`
        using let shared = ReferenceResolver.WithReferences([]string{internalLib.AssemblyPath, publicLib.AssemblyPath})
        let friend = Compilation(shared, SyntaxTree.Parse(SourceText.From(friendSource, "friend.gs"))){
            AssemblyName = "Friend"
        }
        let stranger = Compilation(shared, SyntaxTree.Parse(SourceText.From(strangerSource, "stranger.gs"))){
            AssemblyName = "Stranger"
        }
        using let friendPe = MemoryStream()
        let friendEmit = friend.Emit(friendPe)
        Assert.True(friendEmit.Success, Describe(friendEmit.Diagnostics))
        using let strangerPe = MemoryStream()
        let strangerEmit = stranger.Emit(strangerPe)
        Assert.True(strangerEmit.Success, Describe(strangerEmit.Diagnostics))

        friendPe.Position = 0
        using let friendReader = PEReader(friendPe)
        let friendMd = friendReader.GetMetadataReader()
        let friendItemScope = friendMd
            .TypeReferences
            .Select((h TypeReferenceHandle) -> friendMd.GetTypeReference(h))
            .Single((tr TypeReference) -> friendMd.GetString(tr.Name) == "Item")
            .ResolutionScope
        Assert.Equal(
            "DupGenericInternal",
            friendMd.GetString(friendMd.GetAssemblyReference(cast[AssemblyReferenceHandle](friendItemScope)).Name)
        )

        strangerPe.Position = 0
        using let strangerReader = PEReader(strangerPe)
        let strangerMd = strangerReader.GetMetadataReader()
        let strangerItemScope = strangerMd
            .TypeReferences
            .Select((h TypeReferenceHandle) -> strangerMd.GetTypeReference(h))
            .Single((tr TypeReference) -> strangerMd.GetString(tr.Name) == "Item")
            .ResolutionScope
        Assert.Equal(
            "DupGenericPublic",
            strangerMd.GetString(strangerMd.GetAssemblyReference(cast[AssemblyReferenceHandle](strangerItemScope)).Name)
        )
    }

    @Fact
    func DownlevelEmbeddedNullableAttributes_UseCompilationAssemblyNameOverResolverName() {
        let refDir = typeof(Issue6070SharedResolverAssemblyNameTests)
            .Assembly
            .GetCustomAttributes[AssemblyMetadataAttribute]()
            .Single((attribute AssemblyMetadataAttribute) -> attribute.Key == "NetStandard20ReferenceDirectory")
            .Value!!
        Assert.True(Directory.Exists(refDir))
        using let internalNullables = CSharpFixture(`using System;
using System.Runtime.CompilerServices;
[assembly: InternalsVisibleTo("Friend")]
namespace System.Runtime.CompilerServices {
    [AttributeUsage(AttributeTargets.Class | AttributeTargets.Property | AttributeTargets.Field | AttributeTargets.Event | AttributeTargets.Parameter | AttributeTargets.ReturnValue | AttributeTargets.GenericParameter, AllowMultiple = false, Inherited = false)]
    internal sealed class NullableAttribute : Attribute {
        public NullableAttribute(byte flag) {}
        public NullableAttribute(byte[] flags) {}
    }
    [AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Method | AttributeTargets.Interface | AttributeTargets.Delegate, AllowMultiple = false, Inherited = false)]
    internal sealed class NullableContextAttribute : Attribute {
        public NullableContextAttribute(byte flag) {}
    }
}`, assemblyName: "FriendOnlyNullables")
        let paths = Directory.EnumerateFiles(refDir, "*.dll").Prepend(internalNullables.AssemblyPath).ToArray()
        using let resolver = ReferenceResolver.WithReferences(paths)
        resolver.CurrentAssemblyName = "Friend"
        let source = `package Probe
public func Echo(x string?) string? -> x
`
        let stranger = Compilation(resolver, SyntaxTree.Parse(SourceText.From(source, "stranger.gs"))){
            AssemblyName = "Stranger"
        }
        using let pe = MemoryStream()
        let emitResult = stranger.Emit(pe)
        Assert.True(emitResult.Success, Describe(emitResult.Diagnostics))
        pe.Position = 0
        using let reader = PEReader(pe)
        let md = reader.GetMetadataReader()
        let embeddedTypeNames = md
            .TypeDefinitions
            .Select((h TypeDefinitionHandle) -> md.GetString(md.GetTypeDefinition(h).Name))
            .ToArray()
        Assert.Contains("NullableAttribute", embeddedTypeNames)
        Assert.Contains("NullableContextAttribute", embeddedTypeNames)
        let echoMethod = md
            .MethodDefinitions
            .Select((h MethodDefinitionHandle) -> md.GetMethodDefinition(h))
            .Single((m MethodDefinition) -> md.GetString(m.Name) == "Echo")
        let hasEchoNullableAttr = echoMethod.GetCustomAttributes().Any(
            (h CustomAttributeHandle) -> {
                let ctor = md.GetCustomAttribute(h).Constructor
                if ctor.Kind != HandleKind.MethodDefinition {
                    return false
                }
                let td = md.GetTypeDefinition(
                    md.GetMethodDefinition(cast[MethodDefinitionHandle](ctor)).GetDeclaringType()
                )
                return md.GetString(td.Name) == "NullableContextAttribute"
            }
        )
        Assert.True(hasEchoNullableAttr)
    }

    shared {
        private const SharedLibrarySource string = `using System.Runtime.CompilerServices;
[assembly: InternalsVisibleTo("Friend")]
namespace Lib {
    internal static class SecretType {
        internal static int Value() => 50;
    }
    public class Bag {
        internal int HiddenField = 30;
        internal int HiddenProp => 20;
        internal int HiddenMethod() => 10;
    }
    public static class Api {
        public static Bag Create() => new Bag();
        internal static int Secret() => 42;
    }
    public static class BagExtensions {
        internal static int HiddenExt(this Bag bag) => 40;
    }
}`

        private func Describe(diagnostics System.Collections.Immutable.ImmutableArray[Diagnostic]) string ->
        string.Join(Environment.NewLine, diagnostics.Select((d Diagnostic) -> d.Id + ": " + d.Message))

        private func InvokeRunMethod(peBytes[]uint8, dependencyPath string, typeName string, methodName string) int32 {
            let alc = AssemblyLoadContext("issue6070-${Guid.NewGuid():N}", isCollectible: true)
            try {
                alc.LoadFromAssemblyPath(dependencyPath)
                using let peStream = MemoryStream(peBytes)
                let asm = alc.LoadFromStream(peStream)
                let programType = asm.GetType(typeName, throwOnError: true)!!
                let method = programType.GetMethod(methodName, BindingFlags.Public | BindingFlags.Static)!!
                return cast[int32](method.Invoke(nil, nil)!!)
            } finally {
                alc.Unload()
            }
        }
    }
}
