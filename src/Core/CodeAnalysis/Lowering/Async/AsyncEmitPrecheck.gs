// <copyright file="AsyncEmitPrecheck.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable

/// Safety-net gate that prevents the emitter from crashing on async
/// functions whose state-machine synthesis failed (e.g. the awaitable's
/// method-builder type could not be resolved). When state-machine
/// synthesis succeeds — the normal path — this pass is a no-op.
/// @remarks The gate inspects (cref:Symbols.FunctionSymbol.StateMachineType)
/// which is populated by the async rewriter. A `null` value indicates
/// synthesis failure and triggers a clean compile-time diagnostic rather than
/// a runtime `InvalidProgramException`.
shared class AsyncEmitPrecheck {
    /// The diagnostic message reported when an async function's state-machine synthesis failed.
    const AsyncStateMachineUnavailableMessage string = "Could not synthesize the state machine for this async function; the awaitable's method-builder type could not be resolved. " +
        "See https://github.com/DavidObando/gsharp/issues/52."

    /// Walks [`program`](paramref) and returns one diagnostic per
    /// `async` function whose state-machine synthesis failed
    /// (i.e. `StateMachineType` is `null` after the rewriter ran).
    /// @param program The bound program (post-binding, pre-emit).
    /// @returns The diagnostics to surface; empty when emit may proceed.
    func Check(program BoundProgram?) ImmutableArray[Diagnostic] {
        if program == nil {
            return ImmutableArray[Diagnostic].Empty
        }
        let builder = ImmutableArray.CreateBuilder[Diagnostic]()
        // Issue #4663: deterministic order, never identity-hash order.
        for pair in BoundProgramOrder.Functions(program) {
            let function = pair.Key
            if !function.IsAsyncOrSuspending {
                continue
            }
            // Async iterators are now supported — no gate needed.
            if AsyncIteratorDetection.IsAsyncIteratorFunction(function, pair.Value) {
                continue
            }
            // Gate: async methods that have no successfully synthesized state machine
            // (e.g. builder resolution failed). These remain blocked.
            if function.StateMachineType == nil {
                let location = LocateAsyncFunction(function)
                builder.Add(
                    Diagnostic(location, "GS0190", DiagnosticSeverity.Error, AsyncStateMachineUnavailableMessage)
                )
                continue
            }
        }
        if program.EntryPoint is {} entry && entry.IsAsync && !program.Functions.ContainsKey(entry) {
            if entry.StateMachineType == nil {
                builder.Add(
                    Diagnostic(
                        LocateAsyncFunction(entry),
                        "GS0190",
                        DiagnosticSeverity.Error,
                        AsyncStateMachineUnavailableMessage
                    )
                )
            }
        }
        return builder.ToImmutable()
    }

    private func LocateAsyncFunction(function FunctionSymbol) TextLocation {
        let declaration FunctionDeclarationSyntax? = function.Declaration
        if declaration == nil {
            return TextLocation(SourceText.From(string.Empty), TextSpan(0, 0))
        }
        let anchor = declaration.AsyncModifier ?? declaration.Identifier
        return anchor?.Location ?? declaration.Location
    }
}
