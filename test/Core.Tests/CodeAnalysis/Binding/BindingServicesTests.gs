// <copyright file="BindingServicesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

// Issue #5140: the state keyed by the binding pass (reference set, imports, referencing
// file) lives on one BindingServices per root scope, shared by every body's binder, and an
// independent-body worker scope owns its own instance.
open class BindingServicesTests {
    @Fact
    func EveryScopeOfAChainSharesOneServicesInstance() {
        let root = BoundScope(nil)
        let child = BoundScope(root)
        let grandchild = BoundScope(child)
        Assert.Same(root.GetBindingServices(), child.GetBindingServices())
        Assert.Same(root.GetBindingServices(), grandchild.GetBindingServices())
        Assert.Same(root.GetBindingServices(), BinderContext(grandchild).Services)
        Assert.NotSame(root.GetBindingServices(), BoundScope(nil).GetBindingServices())
    }

    @Fact
    func IndependentBodyScopeOwnsWorkerLocalServices() {
        let root = BoundScope(nil)
        let worker = root.CreateIndependentBodyScope()
        let workerChild = BoundScope(worker)
        Assert.NotSame(root.GetBindingServices(), worker.GetBindingServices())
        Assert.Same(worker.GetBindingServices(), workerChild.GetBindingServices())
    }

    @Fact
    func StaticImportViewIsReusedByTheNextBodysBinderContext() {
        let tree = SyntaxTree.Parse("package Readers\nimport Readers.First\nclass First {}")
        let compilation = Compilation(tree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let import_ = tree.Root.Members.OfType[ImportSyntax]().Single()
        let types = compilation.GlobalScope.Structs.ToDictionary((type StructSymbol) -> type.Name)
        let scope_ = BoundScope(nil)
        scope_.TryDeclareTypeAlias("First", types["First"])
        scope_.TryImport(ImportSymbol("Readers.First", "Readers.First", import_))
        scope_.SetCurrentReferencingSyntaxTree(tree)
        let firstBody = BinderContext(scope_).GetStaticImportTypes()
        let nextBody = BinderContext(scope_).GetStaticImportTypes()
        Assert.Same(types["First"], Assert.Single(firstBody))
        Assert.Equal(firstBody, nextBody)
        Assert.True(firstBody.Equals(nextBody))
        Assert.True(scope_.GetBindingServices().HasCachedStaticImportTypes)
    }
}
