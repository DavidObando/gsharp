// <copyright file="DeclarationBinder.Helpers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Extracted from <see cref="Binder"/> in PR-B-8. Owns every per-declaration-kind
/// binder: type aliases, named delegates, enums, structs (including the large
/// <c>BindStructDeclarationBody</c> driver and its interface-implementation
/// verification pass), interfaces, free / member / extension functions,
/// constructors (<c>init</c>) plus the <c>: base(...)</c> initializer
/// resolver, the two symbol-construction <c>BindVariableDeclaration</c>
/// overloads, generic-parameter binding (<c>BindTypeParameterList</c>), the
/// declaration-side attribute binder (<c>BindAttributes</c>/<c>BindAttribute</c>),
/// and the queue of pending struct→interface implementation checks. The
/// expression binder and most type-name resolution remain on
/// <see cref="Binder"/> and are invoked via the delegate callbacks supplied to
/// the constructor; the same is true for <c>BindBlockStatement</c>-driven
/// body binding (which happens later, in <c>BindProgram</c>, not here).
/// </summary>

internal sealed partial class DeclarationBinder
{


    // Issue #987: classes whose abstract-member contract must be verified after
    // every type body is bound (a concrete class must override all inherited
    // abstract methods). Deferred because a base class' methods may not be bound
    // yet when a derived class declaration is processed.
    private readonly List<(StructDeclarationSyntax Syntax, StructSymbol Symbol)> pendingAbstractImplementationChecks
        = new List<(StructDeclarationSyntax, StructSymbol)>();

    // Issue #1194: field-initializer binding is deferred until after all
    // top-level functions are declared in Binder.BindGlobalScope, so a field
    // initializer can resolve an unqualified call to a free function or a
    // sibling static method/const. Each entry re-establishes the captured
    // scope and the enclosing type's static-member scope before binding.
    private readonly List<Action> pendingFieldInitializerBindings = new List<Action>();

    // Issue #1069: nested struct/class and interface type-name shells declared in
    // phase 1 (DeclareNestedTypeShells) so a sibling member signature can
    // forward-reference a nested type by name. The recorded shells are reused in
    // phase 2 (BindNestedTypeBodies) to bind the bodies without re-declaring the
    // type alias. Nested enums are fully bound during the shell phase (their
    // members reference no user types) and so are not tracked here.
    private readonly Dictionary<StructDeclarationSyntax, StructSymbol> nestedStructShells
        = new Dictionary<StructDeclarationSyntax, StructSymbol>();

#pragma warning disable SA1300 // Element should begin with an uppercase letter
    private BoundScope scope
#pragma warning restore SA1300
    {
        get => binderCtx.RootScope;
        set => binderCtx.RootScope = value;
    }

    /// <summary>
    /// Issue #1070: binds and folds a deferred <c>const</c>-field initializer to a
    /// compile-time constant, reporting GS-not-constant if the expression is not a
    /// constant. Shared by the class-body and <c>shared</c>-block const paths.
    /// </summary>
    /// <summary>
    /// ADR-0122 §10 / issue #1035: returns the unmanaged byte size of a fixed-size
    /// buffer element type. Only the C#-compatible blittable primitives are
    /// permitted (bool, the integer types, char, and the floating-point types).
    /// </summary>
    /// <param name="elementType">The buffer element type.</param>
    /// <param name="size">The element size in bytes when supported.</param>
    /// <returns><see langword="true"/> when the element type is a supported fixed-buffer element.</returns>
    private static bool TryGetFixedBufferElementSize(TypeSymbol elementType, out int size)
    {
        size = 0;
        if (elementType == TypeSymbol.Bool || elementType == TypeSymbol.Int8 || elementType == TypeSymbol.UInt8)
        {
            size = 1;
        }
        else if (elementType == TypeSymbol.Int16 || elementType == TypeSymbol.UInt16 || elementType == TypeSymbol.Char)
        {
            size = 2;
        }
        else if (elementType == TypeSymbol.Int32 || elementType == TypeSymbol.UInt32 || elementType == TypeSymbol.Float32)
        {
            size = 4;
        }
        else if (elementType == TypeSymbol.Int64 || elementType == TypeSymbol.UInt64 || elementType == TypeSymbol.Float64)
        {
            size = 8;
        }

        return size != 0;
    }

    private (FieldSymbol Field, BoundExpression Bound, TextLocation Location) BindConstFieldInitializer(FieldSymbol constField, FieldDeclarationSyntax fieldSyntaxNode, TypeSymbol fieldType)
    {
        var boundInit = bindExpression(fieldSyntaxNode.Initializer);
        var convertedInit = conversions.BindConversion(fieldSyntaxNode.Initializer.Location, boundInit, fieldType);
        var bound = boundInit is BoundErrorExpression || convertedInit is BoundErrorExpression
            ? (BoundExpression)new BoundErrorExpression(fieldSyntaxNode.Initializer)
            : convertedInit;
        return (constField, bound, fieldSyntaxNode.Initializer.Location);
    }

    /// <summary>
    /// Issue #1070: pushes a child scope that exposes the enclosing type's static
    /// members — static fields, const fields, and static properties — as bare
    /// names, then makes it the active binding scope. This mirrors the
    /// static-member visibility that method/constructor bodies already have (see
    /// <c>Binder.BindProgram</c>), so a field initializer (instance
    /// <c>let</c>/<c>var</c>, <c>shared</c> field, or <c>const</c>) can reference a
    /// sibling <c>const</c> or <c>shared</c> field regardless of declaration order.
    /// The returned token restores the previous scope when disposed.
    /// </summary>
    private StaticMemberScope PushStaticMemberScope(StructSymbol structSymbol)
    {
        var previous = binderCtx.RootScope;
        var staticScope = new BoundScope(previous);

        if (!structSymbol.StaticFields.IsDefaultOrEmpty)
        {
            foreach (var fld in structSymbol.StaticFields)
            {
                staticScope.TryDeclareVariable(new ImplicitStaticFieldVariableSymbol(structSymbol, fld));
            }
        }

        if (!structSymbol.ConstFields.IsDefaultOrEmpty)
        {
            foreach (var fld in structSymbol.ConstFields)
            {
                staticScope.TryDeclareVariable(new ImplicitStaticFieldVariableSymbol(structSymbol, fld));
            }
        }

        if (!structSymbol.StaticProperties.IsDefaultOrEmpty)
        {
            foreach (var prop in structSymbol.StaticProperties)
            {
                staticScope.TryDeclareVariable(new ImplicitStaticPropertyVariableSymbol(structSymbol, prop));
            }
        }

        // Issue #1194: expose the enclosing type's static methods by bare name so
        // a field/const/base initializer can call a sibling `static` method
        // unqualified (matching C#). Declared as functions in the innermost
        // scope, they shadow any same-named free function — the C# member-lookup
        // order — and resolve through the normal free-function call path, which
        // emits a static call on the owning method.
        if (!structSymbol.StaticMethods.IsDefaultOrEmpty)
        {
            foreach (var method in structSymbol.StaticMethods)
            {
                staticScope.TryDeclareFunction(method);
            }
        }

        binderCtx.RootScope = staticScope;
        return new StaticMemberScope(binderCtx, previous);
    }

    /// <summary>
    /// Issue #1070: restores the binder's root scope to the value captured before
    /// <see cref="PushStaticMemberScope"/> installed the static-member scope.
    /// </summary>
    private readonly struct StaticMemberScope : System.IDisposable
    {
        private readonly BinderContext binderCtx;
        private readonly BoundScope previous;

        public StaticMemberScope(BinderContext binderCtx, BoundScope previous)
        {
            this.binderCtx = binderCtx;
            this.previous = previous;
        }

        public void Dispose() => binderCtx.RootScope = previous;
    }

    /// <summary>
    /// ADR-0089: shallow signature comparison for a static-virtual interface
    /// slot vs. a candidate implementer method. Static methods have no
    /// implicit <c>this</c>, so all parameters are direct and compared by
    /// type identity and ref-kind.
    /// </summary>
    private static bool StaticVirtualSignaturesMatch(FunctionSymbol iface, FunctionSymbol impl)
    {
        if (iface.Parameters.Length != impl.Parameters.Length)
        {
            return false;
        }

        if (!System.Collections.Generic.EqualityComparer<TypeSymbol>.Default.Equals(iface.Type, impl.Type))
        {
            return false;
        }

        if (iface.ReturnRefKind != impl.ReturnRefKind)
        {
            return false;
        }

        for (var i = 0; i < iface.Parameters.Length; i++)
        {
            if (!System.Collections.Generic.EqualityComparer<TypeSymbol>.Default.Equals(iface.Parameters[i].Type, impl.Parameters[i].Type))
            {
                return false;
            }

            if (iface.Parameters[i].RefKind != impl.Parameters[i].RefKind)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #948: scans an instance field initializer expression for a
    /// reference to <c>this</c>, another instance member, or a constructor
    /// parameter. Such references are illegal because instance field
    /// initializers run before the constructor body (matching C#).
    /// </summary>
    /// <param name="node">The initializer expression syntax to scan.</param>
    /// <param name="forbiddenNames">Instance member and constructor parameter names.</param>
    /// <param name="offendingName">The first offending name found.</param>
    /// <param name="offendingLocation">The location of the first offending reference.</param>
    /// <returns>True when an illegal reference was found.</returns>
    private static bool TryFindInstanceMemberReference(
        SyntaxNode node,
        HashSet<string> forbiddenNames,
        out string offendingName,
        out TextLocation offendingLocation)
    {
        if (node is NameExpressionSyntax nameExpr &&
            forbiddenNames.Contains(nameExpr.IdentifierToken.Text))
        {
            offendingName = nameExpr.IdentifierToken.Text;
            offendingLocation = nameExpr.IdentifierToken.Location;
            return true;
        }

        foreach (var child in node.GetChildren())
        {
            if (TryFindInstanceMemberReference(child, forbiddenNames, out offendingName, out offendingLocation))
            {
                return true;
            }
        }

        offendingName = null;
        offendingLocation = default;
        return false;
    }

    /// <summary>
    /// Issue #948: folds a binary operation over two constant operands. Supports
    /// the constant-expression forms allowed in C# const initializers that the
    /// const-field feature commonly needs: numeric arithmetic and string
    /// concatenation. Returns <c>null</c> for unsupported shapes.
    /// </summary>
    private static object FoldBinary(BoundBinaryOperatorKind kind, object left, object right)
    {
        if (left is string || right is string)
        {
            return kind == BoundBinaryOperatorKind.Sum ? string.Concat(left, right) : null;
        }

        if (left is decimal || right is decimal)
        {
            if (!TryToDecimal(left, out var ld) || !TryToDecimal(right, out var rd))
            {
                return null;
            }

            return kind switch
            {
                BoundBinaryOperatorKind.Sum => ld + rd,
                BoundBinaryOperatorKind.Difference => ld - rd,
                BoundBinaryOperatorKind.Product => ld * rd,
                BoundBinaryOperatorKind.Quotient when rd != 0 => ld / rd,
                _ => (object)null,
            };
        }

        if (left is double || left is float || right is double || right is float)
        {
            var ld = System.Convert.ToDouble(left, System.Globalization.CultureInfo.InvariantCulture);
            var rd = System.Convert.ToDouble(right, System.Globalization.CultureInfo.InvariantCulture);
            return kind switch
            {
                BoundBinaryOperatorKind.Sum => ld + rd,
                BoundBinaryOperatorKind.Difference => ld - rd,
                BoundBinaryOperatorKind.Product => ld * rd,
                BoundBinaryOperatorKind.Quotient when rd != 0 => ld / rd,
                _ => (object)null,
            };
        }

        // Issue #1232: fold `<<`/`>>` with C#/CLR shift semantics. The shift
        // count is masked by the LEFT operand's width (32-bit types → count &
        // 0x1F, 64-bit types → count & 0x3F) and right-shift uses the operand's
        // actual signedness (arithmetic for signed, logical for unsigned), so
        // the compile-time result matches the runtime `shl`/`shr` emission.
        if (kind is BoundBinaryOperatorKind.ShiftLeft or BoundBinaryOperatorKind.ShiftRight)
        {
            return FoldShift(kind, left, right);
        }

        if (!TryToInt64(left, out var li) || !TryToInt64(right, out var ri))
        {
            return null;
        }

        return kind switch
        {
            BoundBinaryOperatorKind.Sum => li + ri,
            BoundBinaryOperatorKind.Difference => li - ri,
            BoundBinaryOperatorKind.Product => li * ri,
            BoundBinaryOperatorKind.Quotient when ri != 0 => li / ri,
            BoundBinaryOperatorKind.Remainder when ri != 0 => li % ri,
            BoundBinaryOperatorKind.BitwiseAnd => li & ri,
            BoundBinaryOperatorKind.BitwiseOr => li | ri,
            BoundBinaryOperatorKind.BitwiseXor => li ^ ri,
            _ => (object)null,
        };
    }

    /// <summary>
    /// Issue #1232: folds a left/right shift over two constant operands using
    /// the same semantics the runtime emits (bare CLR <c>shl</c>/<c>shr</c>). The shift
    /// count is masked by the left operand's CLR width and the operation is
    /// computed in the left operand's actual type so masking, wrap-around and
    /// sign-extension exactly match C#. C# promotes operands narrower than
    /// <c>int</c> to <c>int</c> (32-bit, mask 0x1F); <c>uint</c> is 32-bit;
    /// <c>long</c>/<c>ulong</c> are 64-bit (mask 0x3F). 32-bit results are
    /// widened back to <see cref="long"/> to preserve the Int64 return-shape the
    /// other folded arithmetic ops use; 64-bit results keep their CLR type so
    /// downstream narrowing to the declared const field type stays correct.
    /// </summary>
    private static object FoldShift(BoundBinaryOperatorKind kind, object left, object right)
    {
        if (!TryToInt64(right, out var rawCount))
        {
            return null;
        }

        var is64 = left is long or ulong;
        var count = (int)(rawCount & (is64 ? 0x3F : 0x1F));
        var isLeft = kind == BoundBinaryOperatorKind.ShiftLeft;

        switch (left)
        {
            case long l:
                return isLeft ? l << count : l >> count;
            case ulong ul:
                return isLeft ? ul << count : ul >> count;
            case uint u:
                return (long)(isLeft ? u << count : u >> count);
            case int or short or sbyte or byte or ushort or char:
                var i = System.Convert.ToInt32(left, System.Globalization.CultureInfo.InvariantCulture);
                return (long)(isLeft ? i << count : i >> count);
            default:
                return null;
        }
    }

    private static bool TryToInt64(object value, out long result)
    {
        switch (value)
        {
            case int or long or short or sbyte or byte or ushort or uint:
                result = System.Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture);
                return true;
            case char c:
                result = c;
                return true;
            default:
                result = 0;
                return false;
        }
    }

    private static bool TryToDecimal(object value, out decimal result)
    {
        try
        {
            result = System.Convert.ToDecimal(value, System.Globalization.CultureInfo.InvariantCulture);
            return true;
        }
        catch (System.Exception ex) when (ex is System.InvalidCastException or System.FormatException or System.OverflowException)
        {
            result = 0;
            return false;
        }
    }

    private static object NegateIfNeeded(object operand, bool negate)
    {
        if (!negate)
        {
            return operand;
        }

        return operand switch
        {
            int i => -i,
            long l => -l,
            short s => -s,
            sbyte sb => -sb,
            float f => -f,
            double d => -d,
            decimal m => -m,
            _ => null,
        };
    }

    private void CheckVariancePosition(TypeSymbol type, bool isOutput, TextLocation location)
    {
        if (type is TypeParameterSymbol tp)
        {
            if (tp.Variance == TypeParameterVariance.Out && !isOutput)
            {
                Diagnostics.ReportTypeParameterVariancePositionViolation(location, tp.Name, "out", "input");
            }
            else if (tp.Variance == TypeParameterVariance.In && isOutput)
            {
                Diagnostics.ReportTypeParameterVariancePositionViolation(location, tp.Name, "in", "output");
            }

            return;
        }

        if (type is SliceTypeSymbol s)
        {
            CheckVariancePosition(s.ElementType, isOutput, location);
            return;
        }

        if (type is ArrayTypeSymbol a)
        {
            CheckVariancePosition(a.ElementType, isOutput, location);
            return;
        }

        if (type is NullableTypeSymbol n)
        {
            CheckVariancePosition(n.UnderlyingType, isOutput, location);
            return;
        }
    }

    private static bool IsInlineSynthesizedMemberName(string methodName)
    {
        return methodName == "Equals" ||
            methodName == "GetHashCode" ||
            methodName == "ToString" ||
            methodName == "op_Equality" ||
            methodName == "op_Inequality" ||
            methodName == "Deconstruct";
    }

    /// <summary>
    /// Issue #1017: binds a user-defined conversion operator declaration
    /// (<c>func operator implicit (x T) U { … }</c> or the <c>explicit</c>
    /// variant) into a static <c>op_Implicit</c> / <c>op_Explicit</c>
    /// special-name method attached to the owning user type. Enforces the C#
    /// conversion-operator constraints: exactly one parameter; source and
    /// target differ; at least one of them is a same-package user type; and no
    /// duplicate conversion exists for the same source/target pair.
    /// </summary>
    /// <param name="syntax">The conversion-operator declaration syntax.</param>
    /// <param name="parameters">The already-bound parameter list.</param>
    /// <param name="returnType">The already-bound return (target) type.</param>
    /// <param name="accessibility">The declaration's resolved accessibility.</param>
    /// <param name="package">The owning package.</param>
    /// <param name="functionAttributes">Bound annotation attributes for the declaration.</param>
    private void BindConversionOperatorDeclaration(
        FunctionDeclarationSyntax syntax,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol returnType,
        Accessibility accessibility,
        PackageSymbol package,
        ImmutableArray<BoundAttribute> functionAttributes)
    {
        var isExplicit = syntax.ConversionIsExplicit;
        var opName = isExplicit ? "op_Explicit" : "op_Implicit";

        // A conversion operator has exactly one parameter — the source operand.
        if (parameters.Length != 1)
        {
            Diagnostics.ReportConversionOperatorRequiresSingleParameter(syntax.Identifier.Location, isExplicit);
            return;
        }

        var sourceType = parameters[0].Type;
        var targetType = returnType;

        if (sourceType == TypeSymbol.Error || targetType == TypeSymbol.Error)
        {
            return;
        }

        // The source operand may not be passed by ref/out/in.
        if (parameters[0].RefKind != RefKind.None)
        {
            Diagnostics.ReportConversionOperatorRequiresSingleParameter(syntax.Identifier.Location, isExplicit);
            return;
        }

        // A conversion from a type to itself is never user-definable.
        if (Conversion.Classify(sourceType, targetType).IsIdentity)
        {
            Diagnostics.ReportConversionOperatorMustInvolveEnclosingType(syntax.Identifier.Location);
            return;
        }

        // At least one of source/target must be a same-package user type that
        // owns (emits) the operator.
        var owner = TryGetSamePackageOwner(sourceType, package) ?? TryGetSamePackageOwner(targetType, package);
        if (owner == null)
        {
            Diagnostics.ReportConversionOperatorMustInvolveEnclosingType(syntax.Identifier.Location);
            return;
        }

        var function = new FunctionSymbol(
            opName,
            parameters,
            returnType,
            syntax,
            package,
            accessibility,
            receiverType: null);
        function.IsStatic = true;
        function.StaticOwnerType = owner;
        function.IsSpecialName = true;
        Binder.AttachDocumentation(function, syntax);
        if (!functionAttributes.IsDefaultOrEmpty)
        {
            function.SetAttributes(functionAttributes);
        }

        // Reject a duplicate conversion (same source/target pair), whether the
        // existing one is implicit or explicit — matching C# CS0557.
        foreach (var existing in owner.StaticMethods)
        {
            if (existing.Name != "op_Implicit" && existing.Name != "op_Explicit")
            {
                continue;
            }

            if (existing.Parameters.Length != 1)
            {
                continue;
            }

            if (Conversion.Classify(existing.Parameters[0].Type, sourceType).IsIdentity
                && Conversion.Classify(existing.Type, targetType).IsIdentity)
            {
                Diagnostics.ReportDuplicateConversionOperator(syntax.Identifier.Location, sourceType, targetType);
                return;
            }
        }

        owner.AddStaticMethods(ImmutableArray.Create(function));
    }

    /// <summary>
    /// Issue #1017: returns the same-package <see cref="StructSymbol"/> (struct
    /// or class) definition for <paramref name="type"/> when it is declared in
    /// <paramref name="package"/>, or <see langword="null"/> otherwise.
    /// </summary>
    /// <param name="type">The candidate owner type.</param>
    /// <param name="package">The owning package.</param>
    /// <returns>The owning struct definition, or <see langword="null"/>.</returns>
    private static StructSymbol TryGetSamePackageOwner(TypeSymbol type, PackageSymbol package)
    {
        if (type is StructSymbol structSymbol
            && package != null
            && string.Equals(structSymbol.PackageName, package.Name, StringComparison.Ordinal))
        {
            return structSymbol.Definition ?? structSymbol;
        }

        return null;
    }

    private bool IsSamePackageNonAggregateReceiver(TypeClauseSyntax receiverSyntax, TypeSymbol receiverType, PackageSymbol package)
    {
        if (receiverType is InterfaceSymbol iface)
        {
            return string.Equals(iface.PackageName, package.Name, StringComparison.Ordinal);
        }

        if (receiverType is EnumSymbol enumSymbol)
        {
            return string.Equals(enumSymbol.PackageName, package.Name, StringComparison.Ordinal);
        }

        var receiverName = receiverSyntax?.Identifier?.Text;
        return receiverName != null
            && !isPrimitiveTypeName(receiverName)
            && scope.TryLookupTypeAlias(receiverName, out var aliased)
            && ReferenceEquals(aliased, receiverType)
            && receiverType is not StructSymbol;
    }

    /// <summary>
    /// Issue #1007: signature matching for interface satisfaction / override
    /// resolution, with optional support for generic methods. When the base
    /// (interface) method and the derived (implementing) method are both
    /// generic with the same arity, <paramref name="typeParamMap"/> maps the
    /// base method's type-parameter symbols onto the derived method's so that
    /// the plain type-parameter references in the parameter / return types
    /// compare equal positionally (the interface's <c>T</c> carries a distinct
    /// <see cref="TypeParameterSymbol"/> instance from the class's <c>T</c>).
    /// </summary>
    private static bool SignaturesMatch(
        FunctionSymbol baseMethod,
        ImmutableArray<ParameterSymbol> derivedParams,
        TypeSymbol derivedReturnType,
        RefKind derivedReturnRefKind,
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> typeParamMap,
        bool derivedIsAsync)
    {
        if (!ReturnTypesMatch(baseMethod, derivedReturnType, derivedIsAsync, typeParamMap))
        {
            return false;
        }

        // Issue #490: ref-returning methods must agree on the ref-return-ness with their
        // base or interface; otherwise the override is signature-incompatible.
        if (baseMethod.ReturnRefKind != derivedReturnRefKind)
        {
            return false;
        }

        var baseParams = GetCallableParameters(baseMethod);
        if (baseParams.Length != derivedParams.Length)
        {
            return false;
        }

        for (var i = 0; i < derivedParams.Length; i++)
        {
            if (!TypeSignaturesEquivalent(baseParams[i].Type, derivedParams[i].Type, typeParamMap))
            {
                return false;
            }

            // ADR-0060 §9: two functions that differ only in a parameter's ref-kind
            // are *different signatures*. Required for CLR-faithful override / interface-
            // implementation matching.
            if (baseParams[i].RefKind != derivedParams[i].RefKind)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// ADR-0060 §9: when <see cref="SignaturesMatch(FunctionSymbol, ImmutableArray{ParameterSymbol}, TypeSymbol)"/> rejected an override / interface
    /// implementation, returns the index of the first parameter whose ref-kind disagrees
    /// (return type and pointee types all matching). Returns -1 when the disagreement is
    /// something other than a ref-kind mismatch (so the caller can fall back to the generic
    /// "signature mismatch" diagnostic).
    /// </summary>
    private static int FindRefKindMismatchIndex(FunctionSymbol baseMethod, ImmutableArray<ParameterSymbol> derivedParams, TypeSymbol derivedReturnType)
    {
        if (!TypeSignaturesEquivalent(baseMethod.Type, derivedReturnType))
        {
            return -1;
        }

        var baseParams = GetCallableParameters(baseMethod);
        if (baseParams.Length != derivedParams.Length)
        {
            return -1;
        }

        for (var i = 0; i < derivedParams.Length; i++)
        {
            if (!TypeSignaturesEquivalent(baseParams[i].Type, derivedParams[i].Type))
            {
                return -1;
            }
        }

        for (var i = 0; i < derivedParams.Length; i++)
        {
            if (baseParams[i].RefKind != derivedParams[i].RefKind)
            {
                return i;
            }
        }

        return -1;
    }

    /// <summary>
    /// ADR-0068 / issue #698: binds the optional <c>deinit { … }</c> destructor
    /// on a class body into a synthesized <see cref="FunctionSymbol"/> named
    /// <c>Finalize</c>. The body itself is bound later in
    /// <see cref="Binder.BindProgram(BoundGlobalScope, ReferenceResolver)"/>
    /// alongside method and constructor bodies. Non-class types are rejected
    /// here so the parser-level GS0289 is never the only signal in tools that
    /// skip parser diagnostics.
    /// </summary>
    private void BindDeinitDeclaration(StructDeclarationSyntax syntax, StructSymbol structSymbol, PackageSymbol package)
    {
        var deinitSyntax = syntax.Deinitializer;
        if (deinitSyntax == null)
        {
            return;
        }

        // Defence-in-depth: the parser already reports GS0289 when `deinit`
        // appears inside a non-class body, but if a downstream tool feeds us
        // such a tree directly we must still refuse to synthesise a Finalize
        // symbol for the value type.
        if (!structSymbol.IsClass)
        {
            return;
        }

        var ctorFunction = new FunctionSymbol(
            "Finalize",
            ImmutableArray<ParameterSymbol>.Empty,
            TypeSymbol.Void,
            declaration: null,
            package,
            Accessibility.Private,
            receiverType: structSymbol);

        var deinitSymbol = new DeinitSymbol(ctorFunction, deinitSyntax);
        structSymbol.SetDeinitializer(deinitSymbol);
    }

    private static bool TryParseTargetKind(string text, out AttributeTargetKind kind)
    {
        switch (text)
        {
            case "field": kind = AttributeTargetKind.Field; return true;
            case "param": kind = AttributeTargetKind.Param; return true;
            case "return": kind = AttributeTargetKind.Return; return true;
            case "type": kind = AttributeTargetKind.Type; return true;
            case "method": kind = AttributeTargetKind.Method; return true;
            case "property": kind = AttributeTargetKind.Property; return true;
            case "event": kind = AttributeTargetKind.Event; return true;
            case "module": kind = AttributeTargetKind.Module; return true;
            case "assembly": kind = AttributeTargetKind.Assembly; return true;
            case "genericparam": kind = AttributeTargetKind.GenericParam; return true;
            default: kind = AttributeTargetKind.Method; return false;
        }
    }

    /// <summary>
    /// Issue #660: for test-data attributes like xUnit's <c>@InlineData</c>,
    /// cross-validates nil (null) positional arguments against the owning
    /// method's parameter types. If a nil is supplied for a non-nullable
    /// parameter, reports GS0274.
    /// </summary>
    internal void ValidateInlineDataNilArguments(
        ImmutableArray<BoundAttribute> attributes,
        ImmutableArray<ParameterSymbol> parameters)
    {
        foreach (var attr in attributes)
        {
            if (attr == null)
            {
                continue;
            }

            // Match the InlineDataAttribute by CLR type name (handles any xunit version).
            var clrType = attr.AttributeType?.ClrType;
            if (clrType == null || !clrType.FullName.EndsWith("InlineDataAttribute", StringComparison.Ordinal))
            {
                continue;
            }

            var positional = attr.PositionalArguments;
            var annotation = attr.Syntax;
            if (annotation == null || positional.IsDefaultOrEmpty || parameters.IsDefaultOrEmpty)
            {
                continue;
            }

            // InlineData's positional arguments are expanded into the params
            // object[] — each positional arg[i] corresponds to method parameter[i].
            var argExpressions = annotation.Arguments;
            for (int i = 0; i < positional.Length && i < parameters.Length; i++)
            {
                if (positional[i].Value == null && positional[i].Type == TypeSymbol.Null)
                {
                    var paramType = parameters[i].Type;
                    if (paramType != null && !(paramType is NullableTypeSymbol))
                    {
                        // Get the source location of the nil literal in the argument list.
                        var argLocation = i < argExpressions.Count
                            ? argExpressions[i].Location
                            : annotation.Location;
                        Diagnostics.ReportNilNotAssignableToNonNullableParameter(
                            argLocation,
                            parameters[i].Name,
                            paramType.Name);
                    }
                }
            }
        }
    }
}
