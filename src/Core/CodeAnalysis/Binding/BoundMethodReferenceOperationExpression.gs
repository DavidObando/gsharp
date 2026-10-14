// <copyright file="BoundMethodReferenceOperationExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Reflection
import System.Threading

/// The shape shared by every bound node that REFERENCES a method without
/// calling it — a method group used as a value (ADR-0169, issue #4436). It is
/// the analyzer-facing counterpart of Roslyn's `IMethodReferenceOperation`.
/// @remarks G# binds a method group to a different node for each callee provenance:
/// `BoundMethodGroupExpression` for a same-compilation function and
/// `BoundClrMethodGroupExpression` for an imported one. As with
/// (cref:BoundCallOperationExpression), an analyzer should not have to
/// know the split, so both derive from this base and a rule registers both
/// (cref:BoundNodeKind) values.
abstract class BoundMethodReferenceOperationExpression : BoundExpression {
    private var importedMethod Symbol?

    /// Initializes a new instance of the (cref:BoundMethodReferenceOperationExpression) class.
    /// @param syntax The originating syntax.
    internal init(syntax SyntaxNode?) : base(syntax) { }

    /// Gets the referenced method — the Roslyn
    /// `IMethodReferenceOperation.Method` analogue. It is the selected
    /// overload once the group is resolved against a target delegate type,
    /// and otherwise the group's first candidate. The candidates of one group
    /// share their name and declaring type, which is what the analyzer
    /// surface reads from this symbol. `null` only for an
    /// empty group.
    abstract prop Method Symbol? {
        get;
    }

    /// Gets the receiver the delegate would capture — the Roslyn
    /// `IMethodReferenceOperation.Instance` analogue — or
    /// `null` for a static method.
    abstract prop Instance BoundExpression? {
        get;
    }

    /// Builds, once, the symbol for a reflected method that a group node
    /// stores as a (cref:MethodInfo) rather than a symbol.
    /// @param method The reflected method, or null for an empty group.
    /// @returns The method symbol, or null.
    internal func ImportedMethod(method MethodInfo?) Symbol? {
        if method == nil {
            return nil
        }
        if Volatile.Read(&importedMethod) is {} cached {
            return cached
        }
        // Analyzers may run concurrently: publish the first symbol built, so
        // every reader sees one fully constructed instance.
        let built = ImportedFunctionSymbol(
            method.Name,
            ImportedClassSymbol(ContainingClrType(method), declaration: nil),
            method,
            declaration: nil
        )
        return Interlocked.CompareExchange(&importedMethod, built, nil) ?? built
    }

    shared {
        // The type the method is declared on. A module-level (global) method has
        // no declaring type; its reflected type is the next best answer, and
        // object only when reflection reports neither, which ordinary metadata
        // methods never do.
        private func ContainingClrType(method MethodInfo) Type -> method.DeclaringType ??
            method.ReflectedType ??
            typeof(object)
    }
}
