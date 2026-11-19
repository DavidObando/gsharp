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
