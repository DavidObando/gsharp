// <copyright file="Issue2614ImportedInheritedInstanceMethodTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.InteropServices
import Xunit

class Issue2614ImportedInheritedInstanceMethodTests {
    @Fact
    func OahuBclShapes_BindWithoutGS0159() {
        let result = BindWithFrameworkReferences(`import System.Collections.Concurrent
import System.Security.AccessControl

class ModalRequest { }

func Probe(
    queue ConcurrentQueue[ModalRequest],
    security FileSecurity,
    rule FileSystemAccessRule
) {
    var value ModalRequest? = nil
    queue.TryDequeue(&value)
    security.RemoveAccessRule(rule)
}`)
        Assert.DoesNotContain(result, (diagnostic Diagnostic) -> diagnostic.Id == "GS0159")
        Assert.Empty(result)
    }

    @Fact
    func ImportedLookup_MissingDerivedSignature_WalksBasesAndDefaultInterfaces() {
        Assert.Single(
            MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
                AggregateFailingType(typeof(RootCommand)),
                "SetAction"
            )
        )
        Assert.Single(
            MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
                AggregateFailingType(typeof(DerivedFileSecurity[int32])),
                "RemoveAccessRule"
            )
        )
        Assert.Single(
            MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
                AggregateFailingType(typeof(QueueWithDefault)),
                "TryDequeue"
            )
        )
    }

    @Fact
    func UnknownImportedInstanceMethod_StillReportsGS0159() {
        let diagnostics = BindWithFrameworkReferences(`import System.Collections.Concurrent

func Probe(queue ConcurrentQueue[string]) {
    queue.NotAQueueMethod()
}`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0159", diagnostic.Id)
    }

    private open class Command {
        func SetAction() { }
    }

    private class RootCommand : Command { }

    private open class FileSecurity[T] {
        func RemoveAccessRule(rule T) { }
    }

    private class DerivedFileSecurity[T] : FileSecurity[T] { }

    private interface IQueueDefault {
        func TryDequeue() bool {
            return true
        }
    }

    private class QueueWithDefault : IQueueDefault { }

    private class AggregateFailingType : TypeDelegator {
        private let delegatedType Type

        init(delegatingType Type) : base(delegatingType) {
            delegatedType = delegatingType
        }

        override func GetGenericTypeDefinition() Type -> delegatedType.GetGenericTypeDefinition()

        override func GetMethods(bindingAttr BindingFlags)[]MethodInfo -> if (
            bindingAttr & BindingFlags.DeclaredOnly
        ) == 0 {
            throw FileNotFoundException("Simulated missing metadata dependency.")
            default([]MethodInfo)
        } else {
            base.GetMethods(bindingAttr)
        }
    }

    shared {
        private func BindWithFrameworkReferences(source string) ImmutableArray[Diagnostic] {
            using let references = ReferenceResolver.WithReferences(
                Directory.EnumerateFiles(
                    RuntimeEnvironment.GetRuntimeDirectory(),
                    "*.dll",
                    SearchOption.TopDirectoryOnly
                )
            )
            let compilation = Compilation(references, SyntaxTree.Parse(SourceText.From(source)))
            return compilation
                .SyntaxTrees
                .SelectMany(
                func (tree SyntaxTree) IEnumerable[Diagnostic] {
                    return tree.Diagnostics
                }
            )
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .ToImmutableArray()
        }
    }
}
