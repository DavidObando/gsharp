// <copyright file="ExpressionBinder.Access.Member.2.cs" company="GSharp">
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
using System.Text;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class ExpressionBinder
{


    /// <summary>
    /// Issue #687 (Option A): when a name resolves to a value but also matches an
    /// in-scope type with the same simple name (an imported CLR class, user-defined
    /// struct/class, or enum), surface that type so the caller can apply the
    /// C#-style "color color" preference when the right-hand side of the accessor
    /// is a static member of the type.
    /// </summary>
    private bool TryResolveColorColorType(
        string name,
        NameExpressionSyntax leftName,
        out ImportedClassSymbol importedClassSymbol,
        out StructSymbol userStructSymbol,
        out EnumSymbol enumSymbol)
    {
        importedClassSymbol = null;
        userStructSymbol = null;
        enumSymbol = null;

        if (scope.TryLookupImportedClass(name, leftName, out var importedClass))
        {
            importedClassSymbol = importedClass;
            return true;
        }

        if (scope.TryLookupTypeAlias(name, out var typeAlias))
        {
            if (typeAlias is StructSymbol foundStruct)
            {
                userStructSymbol = foundStruct;
                return true;
            }

            if (typeAlias is EnumSymbol foundEnum)
            {
                enumSymbol = foundEnum;
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #1147 (Facet A): finalizes a "Color Color" member-access CALL whose
    /// receiver name binds to BOTH a value (an in-scope property/field/local/
    /// parameter) and a same-named user struct/class (<paramref name="structSym"/>),
    /// when the invoked method name is declared as BOTH an instance and a static
    /// (<c>shared</c>) overload. The call is resolved against the unified
    /// instance + static overload set and routed by the selected method's
    /// <see cref="FunctionSymbol.IsStatic"/>:
    /// <list type="bullet">
    /// <item>instance overload → the value is bound as the receiver and the call
    /// is dispatched as an ordinary instance call;</item>
    /// <item>static overload → the call is bound as a static member call on the
    /// type.</item>
    /// </list>
    /// Returns <see langword="false"/> (leaving <paramref name="result"/> unset)
    /// when the method name is not declared in BOTH buckets, so the existing #687
    /// type path (static-only) and the value/instance path (instance-only) keep
    /// their current behavior unchanged.
    /// </summary>
    private bool TryBindColorColorUnifiedCall(
        StructSymbol structSym,
        NameExpressionSyntax leftName,
        CallExpressionSyntax ce,
        out BoundExpression result)
    {
        result = null;
        var methodName = ce.Identifier.Text;

        var instanceGroup = TypeMemberModel.GetMethods(structSym, methodName, MemberQuery.Instance(MemberKinds.Method));
        var staticGroup = TypeMemberModel.GetMethods(structSym, methodName, MemberQuery.Static(MemberKinds.Method));

        // Only intercept the genuinely-ambiguous case: the name is declared as
        // BOTH an instance and a static overload. Otherwise defer to the existing
        // paths so behavior is unchanged.
        if (instanceGroup.IsDefaultOrEmpty || staticGroup.IsDefaultOrEmpty)
        {
            return false;
        }

        if (!overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames))
        {
            result = new BoundErrorExpression(null);
            return true;
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(ce.Arguments.Count);
        foreach (var argument in ce.Arguments)
        {
            var argSyntax = OverloadResolver.UnwrapNamedArgumentValue(argument);
            boundArguments.Add(argSyntax is RefArgumentExpressionSyntax refArg
                ? BindRefArgumentExpression(refArg, parameter: null)
                : BindArgumentDeferringBranchy(argSyntax));
        }

        var arguments = boundArguments.ToImmutable();
        var unified = instanceGroup.AddRange(staticGroup);
        var method = overloads.SelectInstanceOverloadOrReport(unified, arguments, ce, methodName, argumentNames);
        if (method == null)
        {
            result = new BoundErrorExpression(null);
            return true;
        }

        if (method.IsStatic)
        {
            // Static overload selected: bind as a static member call on the type
            // (re-resolves the static group, applying optional/variadic/generic
            // fidelity through the shared static-call finalizer).
            result = BindUserTypeStaticCall(structSym, ce);
            return true;
        }

        // Instance overload selected: materialize the value (property / field /
        // local / parameter) as the receiver and dispatch the instance call with
        // the already-bound arguments.
        var receiver = BindNameExpression(leftName);
        if (receiver is BoundErrorExpression)
        {
            result = receiver;
            return true;
        }

        result = overloads.BindUserInstanceCall(receiver, method, arguments, ce, argumentNames);
        return true;
    }

    /// <summary>
    /// Issue #687 (Option A): inspects the right-hand side of an accessor chain
    /// to determine whether it would bind as a static member (field, property,
    /// event, nested type, or method) of the supplied type. Used to decide
    /// between the value and type interpretation when a name collides with a
    /// same-named type in scope. When no static member matches, the binder
    /// falls back to the value interpretation so existing instance-access
    /// semantics continue to work unchanged.
    /// </summary>
    private bool RightPartLooksLikeStaticMember(
        ImportedClassSymbol importedClassSymbol,
        StructSymbol userStructSymbol,
        EnumSymbol enumSymbol,
        ExpressionSyntax rightPart)
    {
        if (!TryGetAccessorChainHead(rightPart, out var headName, out var isCall))
        {
            return false;
        }

        if (importedClassSymbol != null)
        {
            return HasStaticMember(importedClassSymbol.ClassType, headName, isCall);
        }

        if (userStructSymbol != null)
        {
            return HasUserTypeStaticMember(userStructSymbol, headName, isCall);
        }

        if (enumSymbol != null)
        {
            return !isCall && enumSymbol.TryGetMember(headName, out _);
        }

        return false;
    }

    private static bool TryGetAccessorChainHead(ExpressionSyntax rightPart, out string headName, out bool isCall)
    {
        switch (rightPart)
        {
            case CallExpressionSyntax ce when !ce.Identifier.IsMissing:
                headName = ce.Identifier.Text;
                isCall = true;
                return !string.IsNullOrEmpty(headName);

            case NameExpressionSyntax ne when !ne.IdentifierToken.IsMissing:
                headName = ne.IdentifierToken.Text;
                isCall = false;
                return !string.IsNullOrEmpty(headName);

            case AccessorExpressionSyntax acc:
                return TryGetAccessorChainHead(acc.LeftPart, out headName, out isCall);

            case IndexExpressionSyntax ix:
                return TryGetAccessorChainHead(ix.Target, out headName, out isCall);

            case ObjectCreationExpressionSyntax objCreate:
                return TryGetAccessorChainHead(objCreate.Target, out headName, out isCall);

            default:
                headName = null;
                isCall = false;
                return false;
        }
    }

    private bool HasStaticMember(System.Type clrType, string headName, bool isCall)
    {
        if (clrType == null)
        {
            return false;
        }

        if (isCall)
        {
            var methods = ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(clrType, BindingFlags.Public | BindingFlags.Static);
            foreach (var m in methods)
            {
                if (m.Name == headName)
                {
                    return true;
                }
            }

            if (scope.References.TryResolveNestedType(clrType, headName, out _))
            {
                return true;
            }

            return false;
        }

        if (ClrTypeUtilities.SafeGetField(clrType, headName, BindingFlags.Public | BindingFlags.Static) != null)
        {
            return true;
        }

        var prop = ClrTypeUtilities.SafeGetProperty(clrType, headName, BindingFlags.Public | BindingFlags.Static);
        if (prop != null && prop.GetIndexParameters().Length == 0)
        {
            return true;
        }

        if (scope.References.TryResolveNestedType(clrType, headName, out _))
        {
            return true;
        }

        try
        {
            if (clrType.GetEvent(headName, BindingFlags.Public | BindingFlags.Static) != null)
            {
                return true;
            }
        }
        catch (System.Exception)
        {
            // Defensive: some metadata-load-context types throw on event lookup;
            // treat as "no event" so the binder falls back to instance semantics.
        }

        return false;
    }

    private static bool HasUserTypeStaticMember(StructSymbol structSym, string headName, bool isCall)
    {
        if (structSym == null)
        {
            return false;
        }

        // ADR-0112: route through the canonical member-resolution layer.
        if (isCall)
        {
            return !TypeMemberModel.GetMethods(structSym, headName, MemberQuery.Static(MemberKinds.Method)).IsEmpty;
        }

        return TypeMemberModel.LookupMember(
            structSym,
            headName,
            MemberQuery.Static(MemberKinds.Field | MemberKinds.Property)) != null;
    }

    private BoundExpression BindEnumAccessorStep(EnumSymbol enumSymbol, ExpressionSyntax rightPart)
    {
        switch (rightPart)
        {
            case AccessorExpressionSyntax nested:
                var head = BindEnumAccessorStep(enumSymbol, nested.LeftPart);
                if (head is BoundErrorExpression)
                {
                    return head;
                }

                return BindAccessorStep(head, null, nested.RightPart);

            case NameExpressionSyntax ne:
                var memberName = ne.IdentifierToken.Text;
                if (enumSymbol.TryGetMember(memberName, out var member))
                {
                    // Issue #188 / #175: every read of an `@Obsolete` enum
                    // member surfaces GS0204 at the member-identifier
                    // location (e.g. `Color.Red`).
                    reportObsoleteUseIfApplicable(ne.Location, member, $"{enumSymbol.Name}.{member.Name}");
                    return new BoundLiteralExpression(null, member.Value, enumSymbol);
                }

                Diagnostics.ReportUndefinedEnumMember(ne.Location, memberName, enumSymbol.Name);
                return new BoundErrorExpression(null);

            default:
                return new BoundErrorExpression(null);
        }
    }

    /// <summary>
    /// Handles <c>TypeName.member</c> and <c>TypeName.method(args)</c> accessor
    /// resolution for user-defined struct/class static members (ADR-0053).
    /// </summary>
    private BoundExpression BindUserTypeStaticAccessorStep(StructSymbol structSym, ExpressionSyntax rightPart)
    {
        switch (rightPart)
        {
            case AccessorExpressionSyntax nested:
                var head = BindUserTypeStaticAccessorStep(structSym, nested.LeftPart);
                if (head is BoundErrorExpression)
                {
                    return head;
                }

                return BindAccessorStep(head, null, nested.RightPart);

            case CallExpressionSyntax ce:
                return BindUserTypeStaticCall(structSym, ce);

            case NameExpressionSyntax ne:
                return BindUserTypeStaticMemberAccess(structSym, ne);

            // Issue #1291: element access on a qualified static field receiver
            // (`Type.staticField[i]`). The parser folds the trailing `[...]` into
            // the right-hand side of the `.`, so the indexer arrives here as the
            // rightPart. Bind the static-member target through the static
            // accessor path to get the correctly typed (array/map/...) receiver,
            // then route the index resolution through the shared helper — exactly
            // as the instance-receiver path does in BindAccessorStep. Without this
            // case the indexer fell through to `default` and bound to the error
            // type `?`.
            case IndexExpressionSyntax ix:
                var indexTarget = BindUserTypeStaticAccessorStep(structSym, ix.Target);
                if (indexTarget is BoundErrorExpression)
                {
                    return indexTarget;
                }

                if (ix.IsNullConditional)
                {
                    return BindNullConditionalIndexFromBoundTarget(indexTarget, ix);
                }

                return BindIndexAgainstTarget(indexTarget, ix.Index, ix.Target.Location);

            default:
                return new BoundErrorExpression(null);
        }
    }

    /// <summary>
    /// ADR-0089 / issue #1030: resolves <c>IName.StaticField</c> qualified
    /// access against an interface's static *state* (storage or const fields).
    /// Interface static fields have no per-implementer shape — they are plain
    /// CLR static fields on the interface TypeDef — so a read/write binds to a
    /// static (<c>receiver: null</c>) <see cref="BoundFieldAccessExpression"/>
    /// with a <c>null</c> declaring struct (the emitter resolves the field by
    /// symbol identity). Non-field members fall through to an error.
    /// </summary>
    /// <param name="interfaceSym">The interface receiver.</param>
    /// <param name="rightPart">The member being accessed.</param>
    /// <returns>The bound access, or a bound error expression.</returns>
    private BoundExpression BindInterfaceStaticAccessorStep(InterfaceSymbol interfaceSym, ExpressionSyntax rightPart)
    {
        // Issue #1030: a constructed generic interface (`IBox[int32]`) does not
        // re-declare its static fields — they live on the open definition. Look
        // the field up there, but keep `interfaceSym` (the constructed or open
        // symbol) as the carried owner so the emitter parents the field
        // reference at the correct TypeSpec and the interpreter keys storage per
        // construction.
        var fieldOwner = interfaceSym.Definition ?? interfaceSym;
        switch (rightPart)
        {
            case NameExpressionSyntax ne:
                var memberName = ne.IdentifierToken.Text;
                var field = fieldOwner.GetStaticField(memberName);
                if (field != null)
                {
                    return new BoundFieldAccessExpression(null, field, interfaceSym);
                }

                Diagnostics.ReportUnableToFindMember(ne.Location, memberName);
                return new BoundErrorExpression(null);

            case AccessorExpressionSyntax nested:
                var head = BindInterfaceStaticAccessorStep(interfaceSym, nested.LeftPart);
                if (head is BoundErrorExpression)
                {
                    return head;
                }

                return BindAccessorStep(head, null, nested.RightPart);

            default:
                return new BoundErrorExpression(null);
        }
    }

    /// <summary>
    /// ADR-0089 / issue #1030: resolves an index-expression receiver of the
    /// form <c>IBox[int32]</c> to the constructed generic interface symbol when
    /// the indexed target names a generic interface definition and the index
    /// resolves to a type. Returns <c>false</c> for anything else (so the caller
    /// falls back to ordinary index/expression binding).
    /// </summary>
    /// <param name="index">The candidate <c>Target[Index]</c> receiver.</param>
    /// <param name="constructed">The constructed generic interface on success.</param>
    /// <returns>Whether a constructed generic interface receiver was resolved.</returns>
    private bool TryResolveConstructedGenericInterfaceReceiver(IndexExpressionSyntax index, out InterfaceSymbol constructed)
    {
        constructed = null;
        if (index.Target is not NameExpressionSyntax targetName)
        {
            return false;
        }

        if (!scope.TryLookupTypeAlias(targetName.IdentifierToken.Text, out var alias)
            || alias is not InterfaceSymbol ifaceDef
            || !ifaceDef.IsGenericDefinition)
        {
            return false;
        }

        if (!TryBindTypeArgumentExpressions(index.Index, out var typeArgs)
            || typeArgs.Length != ifaceDef.TypeParameters.Length)
        {
            return false;
        }

        constructed = InterfaceSymbol.Construct(ifaceDef, typeArgs);
        return true;
    }

    /// <summary>
    /// Issue #1209: resolves a <c>Name[TypeArg]</c> index-expression receiver
    /// that appears in expression / member-access position to the constructed
    /// generic *type* it names — a user class/struct, a user interface, or an
    /// imported CLR generic type — so qualified static-member access
    /// (<c>Box[int32].Default</c>, <c>ArrayPool[uint8].Shared</c>) and static
    /// method calls bind against the construction rather than as element access.
    /// <para>
    /// Disambiguation rule (avoids breaking genuine indexing such as
    /// <c>arr[i]</c> / <c>dict[key]</c>): the target must be a simple name that
    /// does NOT resolve to a value/variable in scope, AND must resolve to a
    /// generic type definition (user generic class/struct/interface, or imported
    /// CLR generic) whose arity matches the bracketed type-argument count, AND
    /// the bracket contents must parse as type arguments. When the name resolves
    /// to a value, this returns <c>false</c> and the caller binds element access
    /// as before.
    /// </para>
    /// </summary>
    /// <param name="index">The candidate <c>Name[TypeArg]</c> receiver.</param>
    /// <param name="constructedStruct">The constructed generic class/struct on success.</param>
    /// <param name="constructedInterface">The constructed generic interface on success.</param>
    /// <param name="constructedImported">The constructed imported CLR generic type on success.</param>
    /// <returns>Whether a constructed generic type receiver was resolved.</returns>
    private bool TryResolveConstructedGenericTypeReceiver(
        IndexExpressionSyntax index,
        out StructSymbol constructedStruct,
        out InterfaceSymbol constructedInterface,
        out ImportedClassSymbol constructedImported)
    {
        constructedStruct = null;
        constructedInterface = null;
        constructedImported = null;

        if (index.Target is not NameExpressionSyntax targetName)
        {
            return false;
        }

        var name = targetName.IdentifierToken.Text;

        // Genuine indexing (`arr[i]`, `dict[key]`) requires the target to name a
        // value. Only when the name is NOT a value do we consider the
        // constructed-generic-type interpretation.
        if (scope.TryLookupSymbol(name) is VariableSymbol)
        {
            return false;
        }

        // Gate on the name actually naming a generic type definition before
        // binding the bracket contents as type arguments, so that we never emit
        // spurious type diagnostics for a non-generic-type target.
        var arity = FlattenCommaList(index.Index).Count();
        var userGenericDef = scope.TryLookupTypeAlias(name, out var alias)
            && ((alias is StructSymbol sDef && sDef.IsGenericDefinition && sDef.TypeParameters.Length == arity)
                || (alias is InterfaceSymbol iDef && iDef.IsGenericDefinition && iDef.TypeParameters.Length == arity));
        Type openClrType = null;
        var clrGenericDef = !userGenericDef
            && scope.TryLookupImportedGenericClass(name, arity, out openClrType);

        if (!userGenericDef && !clrGenericDef)
        {
            return false;
        }

        if (!TryBindTypeArgumentExpressions(index.Index, out var typeArgs)
            || typeArgs.Length != arity)
        {
            return false;
        }

        if (userGenericDef)
        {
            switch (alias)
            {
                case StructSymbol structDef:
                    constructedStruct = StructSymbol.Construct(structDef, typeArgs);
                    return true;
                case InterfaceSymbol ifaceDef:
                    constructedInterface = InterfaceSymbol.Construct(ifaceDef, typeArgs);
                    return true;
            }
        }

        // Imported CLR generic type: close the open generic definition over the
        // CLR types of the bound type arguments (e.g. ArrayPool`1 + byte ->
        // ArrayPool<byte>) and surface it as an imported class so the existing
        // static-member / static-call binding path resolves members against the
        // closed construction.
        return TryCloseImportedGenericTypeReceiver(openClrType, typeArgs, index, out constructedImported);
    }

    /// <summary>
    /// Issue #1323: resolves a constructed generic type receiver from a
    /// <see cref="GenericNameExpressionSyntax"/> (<c>Box[int32?]</c>,
    /// <c>Pair[int, string]</c>, <c>List[List[int32]]</c>). Unlike the
    /// index-expression form, the type arguments are real
    /// <see cref="TypeClauseSyntax"/> nodes, so nullable/array/nested-generic
    /// arguments bind directly without needing to be reshaped from an
    /// expression. Mirrors the gating of the index-expression overload: the name
    /// must NOT be a value and must name a generic type definition (user
    /// class/struct/interface or imported CLR generic) of matching arity.
    /// </summary>
    /// <param name="generic">The constructed-generic type reference.</param>
    /// <param name="constructedStruct">The constructed generic class/struct on success.</param>
    /// <param name="constructedInterface">The constructed generic interface on success.</param>
    /// <param name="constructedImported">The constructed imported CLR generic type on success.</param>
    /// <returns>Whether a constructed generic type receiver was resolved.</returns>
    private bool TryResolveConstructedGenericTypeReceiver(
        GenericNameExpressionSyntax generic,
        out StructSymbol constructedStruct,
        out InterfaceSymbol constructedInterface,
        out ImportedClassSymbol constructedImported)
    {
        constructedStruct = null;
        constructedInterface = null;
        constructedImported = null;

        var name = generic.Identifier.Text;

        // A value-named receiver is genuine element access, never a type.
        if (scope.TryLookupSymbol(name) is VariableSymbol)
        {
            return false;
        }

        var argClauses = generic.TypeArgumentList.Arguments;
        var arity = argClauses.Count;
        var userGenericDef = scope.TryLookupTypeAlias(name, out var alias)
            && ((alias is StructSymbol sDef && sDef.IsGenericDefinition && sDef.TypeParameters.Length == arity)
                || (alias is InterfaceSymbol iDef && iDef.IsGenericDefinition && iDef.TypeParameters.Length == arity));
        Type openClrType = null;
        var clrGenericDef = !userGenericDef
            && scope.TryLookupImportedGenericClass(name, arity, out openClrType);

        if (!userGenericDef && !clrGenericDef)
        {
            return false;
        }

        var typeArgsBuilder = ImmutableArray.CreateBuilder<TypeSymbol>(arity);
        foreach (var clause in argClauses)
        {
            var bound = bindTypeClause(clause);
            if (bound == null)
            {
                return false;
            }

            typeArgsBuilder.Add(bound);
        }

        var typeArgs = typeArgsBuilder.ToImmutable();

        if (userGenericDef)
        {
            switch (alias)
            {
                case StructSymbol structDef:
                    constructedStruct = StructSymbol.Construct(structDef, typeArgs);
                    return true;
                case InterfaceSymbol ifaceDef:
                    constructedInterface = InterfaceSymbol.Construct(ifaceDef, typeArgs);
                    return true;
            }
        }

        return TryCloseImportedGenericTypeReceiver(openClrType, typeArgs, generic, out constructedImported);
    }

    /// <summary>
    /// ADR-0089 / issue #1030: binds the type-argument expression(s) of a
    /// generic-interface index receiver (<c>int32</c> in <c>IBox[int32]</c>) to
    /// <see cref="TypeSymbol"/>s. Supports a single argument or a comma list
    /// (<c>IPair[int32, string]</c>). Each argument must be a simple/qualified
    /// name or a nested generic; non-type expressions cause a <c>false</c>
    /// result.
    /// </summary>
    /// <param name="argsSyntax">The index expression's argument syntax.</param>
    /// <param name="typeArgs">The bound type arguments on success.</param>
    /// <returns>Whether every argument resolved to a type.</returns>
    private bool TryBindTypeArgumentExpressions(ExpressionSyntax argsSyntax, out ImmutableArray<TypeSymbol> typeArgs)
    {
        typeArgs = default;
        var builder = ImmutableArray.CreateBuilder<TypeSymbol>();
        foreach (var argExpr in FlattenCommaList(argsSyntax))
        {
            if (!TryBuildTypeClauseFromExpression(argExpr, out var typeClause))
            {
                return false;
            }

            var bound = bindTypeClause(typeClause);
            if (bound == null)
            {
                return false;
            }

            builder.Add(bound);
        }

        if (builder.Count == 0)
        {
            return false;
        }

        typeArgs = builder.ToImmutable();
        return true;
    }

    private static IEnumerable<ExpressionSyntax> FlattenCommaList(ExpressionSyntax expr)
    {
        // The parser models `a, b` inside `[...]` as a right-leaning
        // BinaryExpression over comma tokens in some positions; most generic
        // arities used here are single-argument. Yield a single element unless
        // a comma-separated shape is recognised.
        yield return expr;
    }

    /// <summary>
    /// ADR-0089 / issue #1030: reshapes a type-name expression (a simple name
    /// such as <c>int32</c> or a nested generic such as <c>IBox[int32]</c>) into
    /// a <see cref="TypeClauseSyntax"/> so it can be bound by the shared
    /// type-clause binder. Returns <c>false</c> for non-type shapes.
    /// </summary>
    /// <param name="expr">The candidate type expression.</param>
    /// <param name="typeClause">The synthesized type clause on success.</param>
    /// <returns>Whether the expression names a type.</returns>
    private static bool TryBuildTypeClauseFromExpression(ExpressionSyntax expr, out TypeClauseSyntax typeClause)
    {
        typeClause = null;
        if (expr is NameExpressionSyntax ne && !ne.IdentifierToken.IsMissing)
        {
            typeClause = new TypeClauseSyntax(ne.SyntaxTree, ne.IdentifierToken);
            return true;
        }

        return false;
    }

    private BoundExpression BindUserTypeStaticMemberAccess(StructSymbol structSym, NameExpressionSyntax ne)
    {
        var memberName = ne.IdentifierToken.Text;

        // ADR-0112: static field/property lookups go through the canonical layer.
        if (TypeMemberModel.TryGetStaticField(structSym, memberName, out var field))
        {
            return new BoundFieldAccessExpression(null, receiver: null, structSym, field);
        }

        if (TypeMemberModel.TryGetStaticProperty(structSym, memberName, out var prop))
        {
            return new BoundPropertyAccessExpression(null, receiver: null, structSym, prop);
        }

        // ADR-0112: a static (shared) method named here in non-call position is a
        // method group with a null receiver. Overload selection (when more than
        // one shared overload shares the name) is deferred to the conversion
        // classifier, driven by the target delegate signature.
        var staticMethods = TypeMemberModel.GetMethods(structSym, memberName, MemberQuery.Static(MemberKinds.Method));
        if (TryBuildUserMethodGroup(receiver: null, staticMethods, out var staticGroup))
        {
            return staticGroup;
        }

        Diagnostics.ReportUnableToFindMember(ne.Location, memberName);
        return new BoundErrorExpression(null);
    }
}
