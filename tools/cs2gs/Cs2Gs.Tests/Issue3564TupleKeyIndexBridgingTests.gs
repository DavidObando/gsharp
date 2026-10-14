// <copyright file="Issue3564TupleKeyIndexBridgingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import Xunit

/// Issue #3564: tuple-element taint flowing through a generic field/property
/// key promotes that declaration's matching type argument, avoiding unsafe
/// per-use assertions.
open class Issue3564TupleKeyIndexBridgingTests {
    @Fact
    func PromotedTupleKey_PromotesDictionaryFieldKey() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    public class Node
    {
        public string Label { get; set; } = "";
    }

    public class Cache
    {
        private readonly Dictionary<(string, Node), bool> store = new();

        private static string Resolve(Node node) => null;

        public bool Lookup(Node scope)
        {
            var name = Resolve(scope);
            var key = (name, scope);
            if (this.store.TryGetValue(key, out var cached))
            {
                return cached;
            }

            this.store[key] = true;
            return this.store[key];
        }
    }
}`)
        Assert.Contains("let store Dictionary[(string?, Node), bool]", printed)
        Assert.Contains("this.store[key] = true", printed)
        Assert.Contains("return this.store[key]", printed)
        Assert.DoesNotContain("key.Item1!!", printed)
    }

    @Fact
    func PromotedTupleKey_PromotesDictionaryPropertyKeyFromMethodArgument() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    public class Node
    {
    }

    public class Cache
    {
        private Dictionary<(string, Node), bool> Store { get; } = new();

        private static string Resolve(Node node) => null;

        public bool Lookup(Node scope)
        {
            var key = (Resolve(scope), scope);
            return this.Store.TryGetValue(key, out var cached) && cached;
        }
    }
}`)
        Assert.Contains("prop Store Dictionary[(string?, Node), bool]", printed)
        Assert.Contains("this.Store.TryGetValue(key", printed)
        Assert.DoesNotContain("key.Item1!!", printed)
    }

    @Fact
    func TupleValuedTryGetValueOut_DoesNotPromoteReceiverValueType() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    public class Node
    {
        public string Label { get; set; } = "";
    }

    public interface ICache
    {
        Dictionary<(string, Node), (string, Node)> Store { get; }
    }

    public class Cache : ICache
    {
        public Dictionary<(string, Node), (string, Node)> Store { get; } = new();

        private static string Resolve(Node node) => null;

        public bool Lookup(Node scope)
        {
            var key = (scope.Label, scope);
            (string, Node) value = (Resolve(scope), scope);
            return this.Store.TryGetValue(key, out value);
        }
    }
}`)
        Assert.Equal(2, printed.Split("prop Store Dictionary[(string, Node), (string, Node)]").Length - 1)
        Assert.DoesNotContain("Dictionary[(string, Node), (string?, Node)]", printed)
    }

    @Fact
    func ReorderedInheritedGeneric_UsesSubstitutedReceiverArgumentPath() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    public class Node
    {
    }

    public class Reordered<TValue, TKey> : Dictionary<TKey, TValue>
    {
    }

    public class Cache
    {
        private readonly Reordered<bool, (string, Node)> store = new();

        private static string Resolve(Node node) => null;

        public bool Lookup(Node scope)
        {
            var key = (Resolve(scope), scope);
            this.store[key] = true;
            return this.store[key];
        }
    }
}`, "G# does not currently bind inherited indexers on a source generic subclass.")
        Assert.Contains("let store Reordered[bool, (string?, Node)]", printed)
        Assert.Contains("this.store[key] = true", printed)
        Assert.DoesNotContain("key.Item1!!", printed)
    }

    @Fact
    func UnpromotedTupleKey_StaysBare() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    public class Node
    {
        public string Label { get; set; } = "";
    }

    public class Cache
    {
        private readonly Dictionary<(string, Node), bool> store = new();

        public bool Lookup(Node scope)
        {
            var key = (scope.Label, scope);
            this.store[key] = true;
            return this.store[key];
        }
    }
}`)
        Assert.Contains("this.store[key] = true", printed)
        Assert.DoesNotContain("key.Item1!!", printed)
    }

    shared {
        private func TranslateOblivious(source string, roundTripOnlyReason string? = nil) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
