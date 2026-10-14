// <copyright file="BoundClrMethodGroupExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable
import System.Reflection

/// Issue #337: a bare reference to a CLR member method (a method group on an
/// imported static type — e.g. `Console.WriteLine`, `Int32.Parse` —
/// or on a CLR instance receiver — e.g. `sb.Append`) used in a value
/// context. Unlike a named G# function group ((cref:BoundMethodGroupExpression)),
/// the target overload cannot be selected until the expected delegate signature
/// is known, so the binder first produces the <em>unresolved</em> form carrying
/// every name-matching overload, then `BindConversion` picks the single
/// best (cref:MethodInfo) against the target delegate's `Invoke`
/// signature and produces the <em>resolved</em> form. The emitter materializes
/// the resolved form as `ldnull/ldftn` (static) or
/// `[dup] ldftn/ldvirtftn` over the captured receiver (instance), followed
/// by a `newobj` of the target delegate.
class BoundClrMethodGroupExpression : BoundMethodReferenceOperationExpression {
    /// Initializes a new instance of the (cref:BoundClrMethodGroupExpression)
    /// class in its <em>unresolved</em> form: a name-matched set of overload
    /// candidates awaiting overload selection against a target delegate type.
    /// @param syntax The originating syntax node.
    /// @param receiver The instance receiver, or `null` for a static group.
    /// @param declaringType The CLR type declaring the candidates, or `null` when the candidates are
    /// imported free functions with no single declaring type.
    /// @param methodName The method-group name.
    /// @param candidates All name-matching overloads.
    init(
        syntax SyntaxNode?,
        receiver BoundExpression?,
        declaringType Type?,
        methodName string,
        candidates ImmutableArray[MethodInfo]
    ) : base(syntax) {
        Receiver = receiver
        DeclaringType = declaringType
        MethodName = methodName
        Candidates = candidates
    }

    /// Initializes a new instance of the (cref:BoundClrMethodGroupExpression)
    /// class in its <em>resolved</em> form: a single overload selected for a
    /// concrete target delegate type.
    /// @param syntax The originating syntax node.
    /// @param receiver The instance receiver, or `null` for a static group.
    /// @param resolvedMethod The selected overload.
    /// @param delegateType The target delegate type symbol.
    init(syntax SyntaxNode?, receiver BoundExpression?, resolvedMethod MethodInfo, delegateType TypeSymbol) : base(
        syntax
    ) {
        Receiver = receiver
        DeclaringType = resolvedMethod.DeclaringType
        MethodName = resolvedMethod.Name
        Candidates = ImmutableArray.Create(resolvedMethod)
        ResolvedMethod = resolvedMethod
        DelegateType = delegateType
    }

    /// Gets the instance receiver captured as the delegate's target, or
    /// `null` for a group over a static method.
    prop Receiver BoundExpression? {
        get;
    }

    prop DeclaringType Type? {
        get;
    }

    prop MethodName string {
        get;
    }

    prop Candidates ImmutableArray[MethodInfo] {
        get;
    }

    /// Gets the overload selected for the target delegate, or `null` while unresolved.
    prop ResolvedMethod MethodInfo? {
        get;
    }

    /// Gets the target delegate type symbol once resolved, or `null` while unresolved.
    prop DelegateType TypeSymbol? {
        get;
    }

    override prop Type TypeSymbol -> DelegateType ?? TypeSymbol.Error

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Method Symbol? -> ImportedMethod(
        ResolvedMethod ??
            (
            if Candidates.IsDefaultOrEmpty {
                default(MethodInfo?)
            } else {
                Candidates[0]
            }
        )
    )

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Instance BoundExpression? -> Receiver

    override prop Kind BoundNodeKind -> BoundNodeKind.ClrMethodGroupExpression
}
