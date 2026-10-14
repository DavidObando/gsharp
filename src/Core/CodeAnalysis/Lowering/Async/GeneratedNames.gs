// <copyright file="GeneratedNames.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import System.Globalization

/// Deterministic mangled-name generator for compiler-synthesized async
/// state-machine members. The naming scheme intentionally mirrors Roslyn's
/// generated names so PDB tooling and the debugger surface familiar
/// identifiers.
/// @remarks Per ADR-0023 and the Roslyn-async spec (see `~/roslyn-async.md` §4),
/// the CLR does not care about these names; they only matter for debugger
/// experience and (future) Edit-and-Continue stability. GSharp does not
/// support EnC, but adopting Roslyn's scheme keeps the diff visible to
/// users who decompile the produced PE.
///
/// The generator is stateful per-method: state machine kind suffixes
/// (e.g. `d__N`) and per-type awaiter slot indices (`u__N`) are
/// allocated by the caller, which threads its own counters through. All
/// methods on this class are pure.
shared class GeneratedNames {
    /// The hoisted `state` field on a state-machine type.
    const StateField string = "<>1__state"

    /// The hoisted async-method-builder field on a state-machine type.
    const BuilderField string = "<>t__builder"

    /// The hoisted `this` reference field, present when the
    /// containing method is an instance method that captures `this`.
    const ThisField string = "<>4__this"

    /// The shared prefix used by every spill-temp field (and the
    /// corresponding spill-temp local that the spill spiller introduces).
    /// Consumed by (cref:AsyncCaptureWalker) to skip spill temps —
    /// they are managed by the spiller, not the capture walker.
    const SpillTempPrefix string = "<>7__wrap"

    /// Returns the name of the hoisted field that mirrors a parameter of the
    /// original async method.
    /// @param parameterName The user-visible parameter name.
    /// @returns The mangled hoisted-field name.
    func ParameterField(parameterName string) string -> "<>3__" + parameterName

    /// Returns the name of the hoisted field for a user-declared local that
    /// must survive an await suspension.
    /// @param localName The user-visible local name.
    /// @param ordinal A per-method monotonic ordinal that disambiguates
    /// reused names across shadowing scopes (mirrors Roslyn's
    /// `<<name>>5__N` shape).
    /// @returns The mangled hoisted-field name.
    func HoistedLocalField(localName string, ordinal int32) string -> "<" + localName + ">5__" + ordinal.ToString(
        CultureInfo.InvariantCulture
    )

    /// Returns the name of the per-awaiter-type pooled field. One field is
    /// shared across every `await` whose awaiter has the same type;
    /// reference-typed awaiters collapse into a single `System.Object`
    /// field (spec §5, "Awaiter slot pooling").
    /// @param ordinal A per-method monotonic ordinal.
    /// @returns The mangled awaiter-slot field name.
    func AwaiterField(ordinal int32) string -> "<>u__" + ordinal.ToString(CultureInfo.InvariantCulture)

    /// Returns the name of the synthesized state-machine type for an async
    /// method. The type lives as a nested type on the containing type (or
    /// at top-level for the script entry point); the ordinal disambiguates
    /// methods that share a name (overloads / generic instantiations).
    /// @param methodName The original async method's user-visible name.
    /// @param ordinal A per-containing-type monotonic ordinal.
    /// @returns The mangled state-machine type name.
    func StateMachineTypeName(methodName string, ordinal int32) string -> "<" + methodName + ">d__" + ordinal.ToString(
        CultureInfo.InvariantCulture
    )

    /// Returns the name of a reusable hoisted temp introduced by the spiller
    /// (analogue of Roslyn's `<>7__wrapN`).
    /// @param ordinal A per-spiller-pass monotonic ordinal.
    /// @param domain A pass-distinguishing tag appended to the shared
    /// prefix. A method body can run through SEVERAL spiller passes
    /// (control-flow block lifting during general lowering, iterator block
    /// lifting, and the async await spiller), each with its own ordinal
    /// counter starting at zero — without a domain tag two passes both mint
    /// `<>7__wrap0` with different types, and the async state
    /// machine (which maps hoisted locals to fields by name) silently binds
    /// both to one field (issue #3592, ilverify StackUnexpected). Every name
    /// still starts with (cref:SpillTempPrefix) so
    /// (cref:AsyncCaptureWalker)'s prefix detection keeps hoisting
    /// them.
    /// @returns The mangled spill-temp field name.
    func SpillTempField(ordinal int32, domain string = "") string -> SpillTempPrefix + domain + ordinal.ToString(
        CultureInfo.InvariantCulture
    )
}
