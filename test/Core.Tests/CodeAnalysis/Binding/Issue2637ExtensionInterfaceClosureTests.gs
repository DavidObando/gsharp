// <copyright file="Issue2637ExtensionInterfaceClosureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #2637: imported generic extension methods must infer through the
/// receiver's implemented-interface closure.
open class Issue2637ExtensionInterfaceClosureTests {
    @Fact
    func OahuJobScheduler_ConcurrentDictionarySelect_Binds() {
        const source = `package Oahu.Cli.App.Jobs
import System.Collections.Concurrent
import System.Collections.Generic
import System.Linq

class JobLifecycle { prop Id string }
class PersistedJob { prop Id string }

func PersistActiveJobs(jobs ConcurrentDictionary[string, JobLifecycle]) {
    let snapshot = jobs.Select((kv KeyValuePair[string, JobLifecycle]) -> PersistedJob{Id: kv.Value.Id}).ToList()
}`
        AssertBindsWithDefaultAndMetadataResolvers(source)
    }

    @Fact
    func OahuAppShell_ReadOnlyListSelect_Binds() {
        const source = `package Oahu.Cli.Tui.Shell
import System.Collections.Generic
import System.Linq

interface ITabScreen { prop Title string { get; } }

func Render(tabs IReadOnlyList[ITabScreen]) {
    let titles = tabs.Select((t ITabScreen) -> t.Title).ToArray()
}`
        AssertBindsWithDefaultAndMetadataResolvers(source)
    }

    shared {
        private func AssertBindsWithDefaultAndMetadataResolvers(source string) {
            Assert.Empty(BindErrors(source))
            using let resolver = ReferenceResolver.WithReferences(
                []string{
                    typeof(object).Assembly.Location,
                    typeof(ConcurrentDictionary[_, _]).Assembly.Location,
                    typeof(List[_]).Assembly.Location,
                    typeof(Enumerable).Assembly.Location
                }.Distinct(StringComparer.OrdinalIgnoreCase)
            )
            Assert.Empty(BindErrors(source, resolver))
        }

        private func BindErrors(source string, resolver ReferenceResolver? = nil) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let global = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), resolver)
            let program = Binder.BindProgram(global, resolver)
            return tree
                .Diagnostics
                .Concat(global.Diagnostics)
                .Concat(program.Diagnostics)
                .Where((diagnostic Diagnostic) -> diagnostic.IsError)
                .ToImmutableArray()
        }
    }
}
