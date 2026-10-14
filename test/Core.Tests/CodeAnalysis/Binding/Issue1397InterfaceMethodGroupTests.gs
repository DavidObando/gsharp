// <copyright file="Issue1397InterfaceMethodGroupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1397: accessing an instance method as a method group (for delegate
/// conversion, without calling it) on a receiver whose static type is an
/// interface must bind — just as it does for a class receiver. Member lookup
/// for an interface CALL already worked; only the method-group path was broken
/// because it never consulted the interface's member set (including inherited
/// base-interface members).
open class Issue1397InterfaceMethodGroupTests {
    @Fact
    func InterfaceMethodGroup_ToDelegateLocal_BindsClean() {
        const source = `package p
interface IReader { func Run(x int32) int32; }
class Reader : IReader { func Run(x int32) int32 -> x }
class C { func F(reader IReader) { let d (int32) -> int32 = reader.Run } }`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func InterfaceMethodGroup_AsDelegateArgument_BindsClean() {
        const source = `package p
import System.Threading
import System.Threading.Tasks
interface IReader { func RunAsync(cts CancellationTokenSource) Task; }
class Op { init(start async (CancellationTokenSource) -> void) {} }
class C { func F(reader IReader) { let op = Op(reader.RunAsync) } }`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func InheritedInterfaceMethodGroup_ToDelegateLocal_BindsClean() {
        const source = `package p
interface IBase { func Run(x int32) int32; }
interface IReader : IBase {}
class Reader : IReader { func Run(x int32) int32 -> x }
class C { func F(reader IReader) { let d (int32) -> int32 = reader.Run } }`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ClassReceiverMethodGroup_StillBindsClean() {
        const source = `package p
interface IReader { func Run(x int32) int32; }
class Reader : IReader { func Run(x int32) int32 -> x }
class C { func F(reader Reader) { let d (int32) -> int32 = reader.Run } }`
        Assert.Empty(GetDiagnostics(source))
    }

    shared {
        private func GetDiagnostics(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.GlobalScope.Diagnostics.ToList()
        }
    }
}
