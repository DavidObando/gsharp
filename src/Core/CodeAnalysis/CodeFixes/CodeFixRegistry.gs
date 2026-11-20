// <copyright file="CodeFixRegistry.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import SystemObject = System.Object

/// The code-fix providers of a host, in a fixed order (ADR-0227 D2): the built-in providers
/// first, then the providers that the host adds, in the order of the calls.
class CodeFixRegistry {
    private let providers List[GSharpCodeFixProvider] = List[GSharpCodeFixProvider]()
    private let gate object = SystemObject()

    /// Initializes a new instance of the (cref:CodeFixRegistry) class with no provider.
    init() { }

    /// Gets the providers, in registry order.
    prop Providers ImmutableArray[GSharpCodeFixProvider] {
        get {
            lock gate {
                return providers.ToImmutableArray()
            }
        }
    }

    /// Adds a provider after the providers that the registry already has.
    /// @param provider The provider. Its (cref:GSharpCodeFixProvider.FixableDiagnosticIds) must not be empty.
    func Add(provider GSharpCodeFixProvider) {
        ArgumentNullException.ThrowIfNull(provider)
        let ids = provider.FixableDiagnosticIds
        if ids.IsDefaultOrEmpty {
            throw ArgumentException(
                "The code-fix provider '${provider.Id}' names no fixable diagnostic ID (ADR-0227 D2).",
                nameof(provider)
            )
        }
        lock gate {
            providers.Add(provider)
        }
    }

    /// Adds providers in array order.
    /// @param added The providers.
    func AddRange(added IEnumerable[GSharpCodeFixProvider]) {
        ArgumentNullException.ThrowIfNull(added)
        for provider in added {
            Add(provider)
        }
    }

    /// Gets the providers that fix [`diagnosticId`](paramref), in registry order.
    /// @param diagnosticId A diagnostic ID.
    /// @returns The providers.
    func GetProviders(diagnosticId string) ImmutableArray[GSharpCodeFixProvider] -> Providers.Where(
        (p GSharpCodeFixProvider) -> p.FixableDiagnosticIds.Contains(diagnosticId, StringComparer.Ordinal)
    )
        .ToImmutableArray()

    shared {
        /// Creates a registry with the built-in providers of `GSharp.Core` (ADR-0227 D8).
        /// @returns The registry.
        func CreateDefault() CodeFixRegistry {
            let registry = CodeFixRegistry()
            registry.AddRange(BuiltInCodeFixProviders.Create())
            return registry
        }
    }
}
