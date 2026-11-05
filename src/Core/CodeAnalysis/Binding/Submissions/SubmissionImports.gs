// <copyright file="SubmissionImports.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Globalization
import System.Linq

/// ADR-0156 Phase 2: the ordered (newest-first) set of prior interactive
/// submissions a REPL submission binds against. Each prior submission is a
/// real emitted assembly reachable through the compilation's
/// (cref:ReferenceResolver); its top-level functions and globals live
/// as static members of its per-package `<Program>` container and
/// its user types as ordinary CLR types under the submission's package
/// namespace. Name lookup walks submissions newest-first so a redefinition in
/// a later cell shadows earlier cells, matching the historical evaluator
/// scope-chain semantics.
class SubmissionImports {
    private init(newestFirst ImmutableArray[SubmissionReference]) {
        NewestFirst = newestFirst
    }

    /// Gets the prior submissions, newest first.
    prop NewestFirst ImmutableArray[SubmissionReference] {
        get;
    }

    /// Finds the newest prior submission that declares a top-level function
    /// named [`name`](paramref) and resolves its `<Program>`
    /// container type through [`references`](paramref).
    /// @param references The active reference resolver.
    /// @param name The bare function name.
    /// @param programType The container CLR type on success.
    /// @returns Whether a prior submission declares the function.
    func TryFindFunctionContainer(references ReferenceResolver, name string, out programType Type?) bool {
        programType = nil
        for submission in NewestFirst {
            if DeclaresFunction(submission, name) {
                return TryResolveProgramType(references, submission, out programType)
            }
            // A same-named global in a newer submission shadows an older
            // submission's function, mirroring the evaluator scope chain
            // where the newest declaration of a name wins regardless of kind.
            if DeclaresGlobal(submission, name) {
                return false
            }
        }
        return false
    }

    /// Finds the newest prior submission that declares a top-level global
    /// variable named [`name`](paramref), resolving its container type
    /// and reporting the source-side declaration (for read-only checks).
    /// @param references The active reference resolver.
    /// @param name The bare variable name.
    /// @param programType The container CLR type on success.
    /// @param declared The submission's source-side variable symbol.
    /// @returns Whether a prior submission declares the global.
    func TryFindGlobalVariable(
        references ReferenceResolver,
        name string,
        out programType Type?,
        out declared VariableSymbol?
    ) bool {
        programType = nil
        declared = nil
        for submission in NewestFirst {
            let match VariableSymbol? = FindGlobal(submission, name)
            if match != nil {
                declared = match
                return TryResolveProgramType(references, submission, out programType)
            }
            // A same-named function in a newer submission shadows an older
            // submission's global (newest declaration wins regardless of kind).
            if DeclaresFunction(submission, name) {
                return false
            }
        }
        return false
    }

    /// Finds the newest prior submission that declares a top-level function
    /// or global variable named [`name`](paramref) and resolves its
    /// container type. Used by the bare-identifier read fallback, which
    /// binds fields, and method groups through the same accessor machinery.
    /// @param references The active reference resolver.
    /// @param name The bare member name.
    /// @param programType The container CLR type on success.
    /// @returns Whether a prior submission declares the member.
    func TryFindMemberContainer(references ReferenceResolver, name string, out programType Type?) bool {
        programType = nil
        for submission in NewestFirst {
            if DeclaresFunction(submission, name) || DeclaresGlobal(submission, name) {
                return TryResolveProgramType(references, submission, out programType)
            }
        }
        return false
    }

    /// Finds the newest prior submission that declares a type (struct, class,
    /// interface, enum, or delegate) named [`name`](paramref) and
    /// resolves its emitted CLR type through [`references`](paramref).
    /// @param references The active reference resolver.
    /// @param name The simple type name.
    /// @param preferredArity The preferred generic arity, or -1/0 for a non-generic use site.
    /// @param clrType The resolved CLR type on success.
    /// @returns Whether a prior submission declares the type.
    func TryResolveType(
        references ReferenceResolver,
        name string,
        preferredArity int32,
        @NotNullWhen(true) out clrType Type?
    ) bool {
        clrType = nil
        for submission in NewestFirst {
            let arity = FindDeclaredTypeArity(submission, name, preferredArity)
            if arity < 0 {
                continue
            }
            let metadataName = if arity == 0 {
                name
            } else {
                name + "`" + arity.ToString(CultureInfo.InvariantCulture)
            }
            return references.TryResolveTypeInAssembly(
                submission.AssemblyName,
                submission.PackageName + "." + metadataName,
                out clrType
            )
        }
        return false
    }

    shared {
        /// The reserved name of the synthesized public static field that receives
        /// the value of a submission's trailing expression (or trailing variable
        /// declaration) for the REPL's cell-value echo.
        const ResultFieldName string = "<Result>$$"

        /// The metadata type name of the per-package top-level container that
        /// holds a submission's top-level functions (static methods) and globals
        /// (static fields).
        const ProgramTypeName string = "<Program>"

        /// Gets the metadata name of a package's synthesized top-level container.
        /// @param packageName The declaring package.
        /// @returns The package-qualified metadata type name.
        func GetProgramTypeName(packageName string) string -> packageName + "." + ProgramTypeName

        /// Creates a (cref:SubmissionImports) over the given prior
        /// submissions.
        /// @param newestFirst The prior submissions, newest first.
        /// @returns The import set.
        func Create(newestFirst ImmutableArray[SubmissionReference]) SubmissionImports -> SubmissionImports(
            if newestFirst.IsDefault {
                ImmutableArray[SubmissionReference].Empty
            } else {
                newestFirst
            }
        )

        private func DeclaresFunction(submission SubmissionReference, name string) bool -> submission
            .GlobalScope
            .Functions
            .Any(
            (f FunctionSymbol) -> !f.IsSpecialName && !f.IsTopLevelEntryPoint && string.Equals(
                f.Name,
                name,
                StringComparison.Ordinal
            )
        )

        private func DeclaresGlobal(submission SubmissionReference, name string) bool -> FindGlobal(
            submission,
            name
        ) != nil

        private func FindGlobal(submission SubmissionReference, name string) VariableSymbol? -> if string.Equals(
            name,
            ResultFieldName,
            StringComparison.Ordinal
        ) {
            default(VariableSymbol?)
        } else {
            submission
                .GlobalScope
                .Variables
                .FirstOrDefault(
                (v VariableSymbol) -> v is GlobalVariableSymbol && string.Equals(v.Name, name, StringComparison.Ordinal)
            )
        }

        // Returns the declared generic arity of the newest matching type in this
        // submission, or -1 when the submission does not declare the name. When
        // the use site requests a specific arity (> 0), only a same-arity
        // declaration matches; a bare use site (-1 or 0) matches a non-generic
        // declaration first and otherwise any declared arity.
        private func FindDeclaredTypeArity(submission SubmissionReference, name string, preferredArity int32) int32 {
            let scope_ = submission.GlobalScope
            let arities = scope_
                .Structs
                .Where((s StructSymbol) -> string.Equals(s.Name, name, StringComparison.Ordinal))
                .Select(
                (s StructSymbol) -> if s.TypeParameters.IsDefaultOrEmpty {
                    0
                } else {
                    s.TypeParameters.Length
                }
            )
                .Concat(
                scope_
                    .Interfaces
                    .Where((i InterfaceSymbol) -> string.Equals(i.Name, name, StringComparison.Ordinal))
                    .Select(
                    (i InterfaceSymbol) -> if i.TypeParameters.IsDefaultOrEmpty {
                        0
                    } else {
                        i.TypeParameters.Length
                    }
                )
            )
                .Concat(
                scope_
                    .Enums
                    .Where((e EnumSymbol) -> string.Equals(e.Name, name, StringComparison.Ordinal))
                    .Select((_ EnumSymbol) -> 0)
            )
                .Concat(
                scope_
                    .Delegates
                    .Where((d DelegateTypeSymbol) -> string.Equals(d.Name, name, StringComparison.Ordinal))
                    .Select(
                    (d DelegateTypeSymbol) -> if d.TypeParameters.IsDefaultOrEmpty {
                        0
                    } else {
                        d.TypeParameters.Length
                    }
                )
            )
                .ToArray()
            if arities.Length == 0 {
                return -1
            }
            if preferredArity > 0 {
                return if arities.Contains(preferredArity) {
                    preferredArity
                } else {
                    -1
                }
            }
            return if arities.Contains(0) {
                0
            } else {
                arities[0]
            }
        }

        // Issue #3297: resolve against the declaring submission's own assembly,
        // not the flat namespace-qualified name. Two cells that redeclare the
        // same `package foo` each emit a `foo.<Program>` container into their own
        // submission assembly (`gsi$1`, `gsi$2`); the flat lookup collides on the
        // newest, which made the older cell's declarations unreachable even
        // though the newest-first declaration walk had correctly found them.
        private func TryResolveProgramType(
            references ReferenceResolver,
            submission SubmissionReference,
            out programType Type?
        ) bool -> references.TryResolveTypeInAssembly(
            submission.AssemblyName,
            GetProgramTypeName(submission.PackageName),
            out programType
        )
    }
}

/// One prior interactive submission: its emitted assembly identity, the
/// package (namespace) its members were emitted under, and the source-side
/// global scope recording what it declared (names, kinds, and read-only
/// flags — used to steer metadata lookup without reflection scans).
class SubmissionReference {
    /// Initializes a new instance of the (cref:SubmissionReference) class.
    /// @param assemblyName The emitted assembly's simple name (e.g. `gsi$3`).
    /// @param packageName The package (metadata namespace) the submission's members were emitted under.
    /// @param globalScope The submission's bound global scope.
    init(assemblyName string, packageName string, globalScope BoundGlobalScope) {
        AssemblyName = assemblyName ?? throw ArgumentNullException("assemblyName")
        PackageName = packageName ?? throw ArgumentNullException("packageName")
        GlobalScope = globalScope ?? throw ArgumentNullException("globalScope")
    }

    /// Gets the emitted assembly's simple name.
    prop AssemblyName string {
        get;
    }

    /// Gets the package (metadata namespace) of the submission's members.
    prop PackageName string {
        get;
    }

    /// Gets the submission's bound global scope.
    prop GlobalScope BoundGlobalScope {
        get;
    }
}

/// ADR-0156 Phase 2: options that put a compilation into interactive
/// submission mode — prior-submission metadata binding, a per-submission
/// default package, replayed session imports, and trailing-expression value
/// capture for the REPL echo.
class SubmissionBindingOptions {
    /// Gets or sets the prior-submission import set (may be `null` for the first cell).
    prop Imports SubmissionImports?

    /// Gets or sets the package name used for syntax trees without a
    /// `package` declaration (each submission gets a distinct default
    /// package so its emitted members have a unique namespace).
    prop DefaultPackageName string?

    /// Gets or sets the imports accumulated by earlier submissions, replayed
    /// into this submission's root scope so `import` statements keep
    /// their session-wide effect.
    private var _replayImports ImmutableArray[ImportSymbol] = ImmutableArray[ImportSymbol].Empty

    prop ReplayImports ImmutableArray[ImportSymbol] {
        get {
            return _replayImports
        }
        set {
            _replayImports = value
        }
    }

    /// Gets or sets a value indicating whether the trailing expression (or
    /// trailing variable declaration) of the submission is captured into the
    /// synthesized (cref:SubmissionImports.ResultFieldName) global for
    /// the REPL's cell-value echo. Defaults to `true`.
    private var _captureTrailingExpression bool = true

    prop CaptureTrailingExpression bool {
        get {
            return _captureTrailingExpression
        }
        set {
            _captureTrailingExpression = value
        }
    }

    /// Gets or sets a value indicating whether a user-declared entry point
    /// (`func Main`) becomes the submission assembly's entry point.
    /// Interactive cells leave this `false` — declaring
    /// `Main` in a REPL cell is an ordinary function declaration with no
    /// side effect (ADR-0156 Phase 3c, #3176; the evaluator engine's
    /// `RunEntryPoint=false` contract). One-shot script-shaped
    /// submissions (the emitted test oracle) opt in to preserve
    /// `Compilation.Evaluate`'s historical script semantics, where an
    /// explicit `Main` runs and its return value is the result.
    prop RunUserEntryPoint bool
}
