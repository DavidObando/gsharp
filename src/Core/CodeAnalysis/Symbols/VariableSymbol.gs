// <copyright file="VariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Represents a variable symbol in the language.
abstract class VariableSymbol : Symbol {
    /// Initializes a new instance of the (cref:VariableSymbol) class.
    /// @param name The variable's name.
    /// @param isReadOnly Whether it's read-only or not.
    /// @param type The variable's type.
    /// @param declaringSyntax The originating declaration syntax (may be `null` for
    /// compiler-synthesised variables — async/iterator state-machine slots,
    /// lowering temporaries, etc.). Used by the Portable PDB emitter to map
    /// IL local slots back to source for stepping and locals display per
    /// ADR-0027 §7.7a.
    init(name string, isReadOnly bool, type TypeSymbol, declaringSyntax SyntaxNode? = nil) : base(name) {
        IsReadOnly = isReadOnly
        Type = type
        DeclaringSyntax = declaringSyntax
    }

    /// Gets a value indicating whether it's read-only or not.
    prop IsReadOnly bool {
        get;
    }

    /// Gets the variable's type.
    prop Type TypeSymbol {
        get;
        internal set;
    }

    /// Gets the originating declaration syntax for this variable, or
    /// `null` when the variable is compiler-synthesised and
    /// has no source-level declaration. Consumed by the Portable PDB emitter
    /// to anchor `LocalVariable` rows and (for hoisted async/iterator
    /// state-machine locals) the hoisted-local-scope `CustomDebugInformation`.
    prop DeclaringSyntax SyntaxNode? {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override prop DeclaringSyntaxNodes ImmutableArray[SyntaxNode] -> if DeclaringSyntax is {} declaration {
        ImmutableArray.Create(declaration)
    } else {
        ImmutableArray[SyntaxNode].Empty
    }

    /// Gets or sets a value indicating whether this read-only variable's
    /// initializer was proven non-null from its bound expression.
    internal prop HasDefinitelyNonNullValue bool

    /// Gets or sets the recursive callable parameter-name tree captured from a
    /// function literal, function-pointer, or (possibly nested) tuple initializer.
    internal prop CallableParameterNameTree CallableParameterNameNode?

    /// Gets or sets callable parameter names captured from a function literal
    /// or function-pointer initializer. Empty when the variable's callable
    /// shape carries types only.
    internal prop CallableParameterNames ImmutableArray[string] {
        get -> CallableParameterNameTree?.Names ?? default(ImmutableArray[string])
        set {
            CallableParameterNameTree = if value.IsDefaultOrEmpty {
                if CallableParameterNameTree is {Elements: var existingElements, ReturnValue: var existingReturn} &&
                    (!existingElements.IsDefaultOrEmpty || existingReturn != nil) {
                    CallableParameterNameNode(default(ImmutableArray[string]), existingElements, existingReturn)
                } else {
                    nil
                }
            } else {
                CallableParameterNameNode(
                    value,
                    CallableParameterNameTree?.Elements ?? default(ImmutableArray[CallableParameterNameNode?]),
                    CallableParameterNameTree?.ReturnValue
                )
            }
        }
    }
}

internal class CallableParameterNameNode {
    init(
        names ImmutableArray[string],
        elements ImmutableArray[CallableParameterNameNode?] = default(ImmutableArray[CallableParameterNameNode?]),
        returnValue CallableParameterNameNode? = nil
    ) {
        Names = names
        Elements = elements
        ReturnValue = returnValue
    }

    prop Names ImmutableArray[string] {
        get;
    }

    prop Elements ImmutableArray[CallableParameterNameNode?] {
        get;
    }

    prop ReturnValue CallableParameterNameNode? {
        get;
    }

    shared {
        internal func Merge(
            left CallableParameterNameNode?,
            right CallableParameterNameNode?
        ) CallableParameterNameNode? {
            if object.ReferenceEquals(left, right) {
                return left
            }
            if left == nil || right == nil {
                return nil
            }
            let leftNames = left.Names
            let rightNames = right.Names
            var namesMatch = !leftNames.IsDefaultOrEmpty &&
                !rightNames.IsDefaultOrEmpty &&
                leftNames.Length == rightNames.Length
            if namesMatch {
                for var i = 0; i < leftNames.Length; i++ {
                    if leftNames[i] != rightNames[i] {
                        namesMatch = false
                        break
                    }
                }
            }
            let mergedNames = if namesMatch {
                leftNames
            } else {
                default(ImmutableArray[string])
            }
            let leftElements = left.Elements
            let rightElements = right.Elements
            var anyElement = false
            let mergedElements = if !leftElements.IsDefaultOrEmpty &&
                !rightElements.IsDefaultOrEmpty &&
                leftElements.Length == rightElements
                .Length {
                let builder = ImmutableArray.CreateBuilder[CallableParameterNameNode?](leftElements.Length)
                for var i = 0; i < leftElements.Length; i++ {
                    let mergedChild = Merge(leftElements[i], rightElements[i])
                    anyElement |= mergedChild != nil
                    builder.Add(mergedChild)
                }
                if anyElement {
                    builder.MoveToImmutable()
                } else {
                    default(ImmutableArray[CallableParameterNameNode?])
                }
            } else {
                default(ImmutableArray[CallableParameterNameNode?])
            }
            let mergedReturn = Merge(left.ReturnValue, right.ReturnValue)
            if mergedNames.IsDefaultOrEmpty && mergedElements.IsDefaultOrEmpty && mergedReturn == nil {
                return nil
            }
            return CallableParameterNameNode(mergedNames, mergedElements, mergedReturn)
        }
    }
}
