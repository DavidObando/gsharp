// <copyright file="BoundBaseClassCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis

/// Issue #986: a base-class call expression of the form
/// `base.Method(args)` (and the bracketed
/// `base[BaseClass].Method(args)` form). Lets an override delegate to
/// the nearest base class's virtual implementation non-virtually — exactly
/// like C# `base.M(...)`. The emitter lowers this to
/// `ldarg.0` + a non-virtual `call instance R BaseClass::Method(...)`;
/// the interpreter dispatches directly to the base method body without
/// re-entering the derived type's v-table (which would recurse infinitely).
class BoundBaseClassCallExpression : BoundExpression {
    private let returnTypeOverride TypeSymbol?

    /// Initializes a new instance of the (cref:BoundBaseClassCallExpression) class.
    /// @param syntax The originating syntax.
    /// @param receiver The implicit `this` receiver of the enclosing instance member.
    /// @param baseClass The base class whose member is invoked (the declaring type of
    /// [`method`](paramref)).
    /// @param method The base-class method whose implementation is invoked non-virtually, or `null` for a
    /// base auto-property accessor (issue #1347), in which case [`property`](paramref) identifies the
    /// accessor and [`returnTypeOverride`](paramref) must be supplied.
    /// @param arguments The bound argument expressions in declared order.
    /// @param returnTypeOverride Optional substituted return type for a constructed generic base; `null`
    /// uses (cref:FunctionSymbol.Type). Required when [`method`](paramref) is `null`.
    /// @param property Issue #1347: the base auto-property whose synthesized accessor is invoked
    /// non-virtually, or `null` for an ordinary method/computed-accessor call.
    /// @param isSetterAccessor Issue #1347: when [`property`](paramref) is set, whether the setter accessor
    /// (rather than the getter) is invoked.
    init(
        syntax SyntaxNode?,
        receiver BoundExpression,
        baseClass StructSymbol,
        method FunctionSymbol?,
        arguments ImmutableArray[BoundExpression],
        returnTypeOverride TypeSymbol? = nil,
        property PropertySymbol? = nil,
        isSetterAccessor bool = false
    ) : base(syntax) {
        Receiver = receiver
        BaseClass = baseClass
        Method = method
        Arguments = arguments
        this.returnTypeOverride = returnTypeOverride
        Property = property
        IsSetterAccessor = isSetterAccessor
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.BaseClassCallExpression

    // The constructor requires returnTypeOverride whenever method is null (a
    // base auto-property accessor, issue #1347), so at least one is present.
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> returnTypeOverride ?? Invariant.Required(
        Method,
        "the property-accessor form (Method null) is only constructed with a returnTypeOverride, so a null override means this is the method form",
        expression: "Method"
    )
        .Type

    /// Gets the implicit `this` receiver — a (cref:BoundVariableExpression) reading the enclosing method's
    /// first parameter.
    prop Receiver BoundExpression {
        get;
    }

    /// Gets the base class whose member is invoked (the declaring type of (cref:Method) or
    /// (cref:Property)).
    prop BaseClass StructSymbol {
        get;
    }

    /// Gets the base-class method whose implementation is invoked non-virtually, or `null` for a base
    /// auto-property accessor (issue #1347).
    prop Method FunctionSymbol? {
        get;
    }

    /// Gets a value indicating whether this is the auto-property-accessor form
    /// (issue #1347) rather than the ordinary method form. The two forms are
    /// complementary: exactly one of (cref:Property) and
    /// (cref:Method) is present, so this discriminates both.
    @MemberNotNullWhen(true, "Property")
    @MemberNotNullWhen(false, "Method")
    prop IsPropertyAccessor bool -> Property != nil

    /// Gets the base auto-property whose synthesized accessor is invoked
    /// non-virtually, or `null` for an ordinary method or
    /// computed-accessor call (issue #1347). Auto-properties have no accessor
    /// (cref:FunctionSymbol), so the accessor is resolved through the
    /// property's emitted get_/set_ MethodDef (or, in the interpreter, its
    /// synthesized backing field).
    prop Property PropertySymbol? {
        get;
    }

    /// Gets a value indicating whether (cref:Property)'s setter accessor (rather than its getter) is
    /// invoked (issue #1347).
    prop IsSetterAccessor bool {
        get;
    }

    /// Gets the bound argument expressions in declared order.
    prop Arguments ImmutableArray[BoundExpression] {
        get;
    }

    /// Gets the method type arguments of a call to a generic base method
    /// (`base.Id[int32](7)`), explicit or inferred, as the binder
    /// resolved them. Default when the method is not generic, or when the
    /// binder left them to structural inference at emit time.
    prop MethodTypeArguments ImmutableArray[TypeSymbol] {
        get;
        init;
    }
}
