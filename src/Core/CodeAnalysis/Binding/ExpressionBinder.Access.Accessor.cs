// <copyright file="ExpressionBinder.Access.Accessor.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
    private BoundExpression BindAccessorExpression(AccessorExpressionSyntax syntax)
    {
        // Issue #1323: a GenericNameExpression only arises from the parser as the
        // receiver of a member access; the accessor leftPart switch below resolves
        // it to a constructed generic type. See BindGenericNameExpression for the
        // standalone (non-receiver) diagnostic path.
        // Phase 3.C.3b / ADR-0001: null-conditional access `lhs?.rhs`.
        // Evaluate the receiver once, capture it into a synthetic local,
        // then bind the rest of the access against the capture so the
        // subtree can be evaluated against the non-nil value without a
        // second evaluation of the receiver expression.
        if (syntax.IsNullConditional)
        {
            return BindNullConditionalAccessExpression(syntax);
        }

        // Issue #293: a fully-qualified imported-type constructor
        // (`System.Text.StringBuilder()`, `System.Collections.Generic.List[int]()`)
        // parses as an accessor chain whose terminal segment is the call, so it
        // never reaches the simple-name constructor path in BindCallExpression.
        // Resolve it the same way here so construction works identically whether
        // written as a simple name or a fully-qualified path, at top level and
        // inside function/method bodies alike.
        if (TryBindQualifiedClrConstructorCall(syntax, out var qualifiedCtorCall))
        {
            return qualifiedCtorCall;
        }

        // Issue #2258: a fully-qualified imported-type object-initializer
        // literal (`System.Text.Json.JsonWriterOptions{ Indented: true }`)
        // parses as an accessor chain whose terminal segment is the struct
        // literal, so it never reaches the simple-name literal path below.
        if (TryBindQualifiedClrStructLiteral(syntax, out var qualifiedClrLiteral))
        {
            return qualifiedClrLiteral;
        }

        // Resolve an exact CLR namespace/type path before the flat source-type
        // fallback below can select an unrelated same-simple-name source type.
        if (!syntax.IsNullConditional
            && !QualifiedAccessStartsWithValue(syntax)
            && syntax.LeftPart is NameExpressionSyntax qualifiedClrRoot
            && syntax.RightPart is not NameExpressionSyntax)
        {
            ExpressionSyntax qualifiedClrMember = syntax.RightPart;
            if (TryBindFullyQualifiedClrStaticAccess(
                qualifiedClrRoot, ref qualifiedClrMember, out var qualifiedClrType))
            {
                return BindAccessorStep(null, qualifiedClrType, qualifiedClrMember);
            }
        }

        // A same-compilation SOURCE type constructed/referenced through a
        // package-qualified name — `Oahu.Decrypt.Mp4Operation(...)`,
        // `Oahu.Decrypt.Mp4Operation[TResult](...)`. Source types are visible by
        // simple name across packages, but the qualified path above only resolves
        // CLR-backed reference types (a source type has no CLR type at bind time).
        // When the leading segments are a pure namespace/package prefix (none names
        // a value, type, import, or imported class) and the terminal simple name
        // is a user aggregate, peel the redundant prefix and bind the terminal by
        // simple name. cs2gs fully-qualifies constructor calls, so this is the
        // common translated shape.
        if (TryBindQualifiedSourceTypeConstruction(syntax, out var qualifiedSourceCtor))
        {
            return qualifiedSourceCtor;
        }

        // Issue #1069: a nested user type referenced by a qualified name from
        // outside its enclosing type (`Outer.Entry(...)`, `Outer.Inner().M()`).
        // Nested types are also visible by their simple name in the flat package
        // scope, so an enclosing-type qualifier in front of a nested-type
        // construction/member-access is redundant: peel it off and bind the
        // remainder by simple name. This mirrors how the enclosing type's own
        // members reference a sibling nested type. It only fires when the left
        // segment is a user aggregate type and the next segment names one of its
        // nested types, and never for a bare-name terminal segment (handled as a
        // type receiver below), so it cannot shadow ordinary static-member access.
        if (syntax.LeftPart is NameExpressionSyntax enclosingNameSyntax
            && syntax.RightPart is not NameExpressionSyntax
            && scope.TryLookupSymbol(enclosingNameSyntax.IdentifierToken.Text) is not VariableSymbol
            && scope.TryLookupTypeAlias(enclosingNameSyntax.IdentifierToken.Text, out var enclosingAliasType)
            && IsUserAggregateType(enclosingAliasType)
            && TryGetHeadIdentifier(syntax.RightPart, out var headIdentifier))
        {
            // Issue #1174: when a top-level type shares the nested type's simple
            // name, re-binding the right part by simple name would resolve to the
            // top-level homonym (which holds the simple key). Resolve the nested
            // type by (container, simpleName) and bind the qualified composite
            // literal directly against the NESTED definition so its members
            // resolve correctly.
            if (syntax.RightPart is StructLiteralExpressionSyntax nestedLiteral)
            {
                var literalArity = nestedLiteral.TypeArgumentList != null ? nestedLiteral.TypeArgumentList.Arguments.Count : -1;
                if (scope.TryLookupNestedTypeAlias(enclosingAliasType, headIdentifier, literalArity, out var nestedLiteralType)
                    && nestedLiteralType is StructSymbol nestedStructDef)
                {
                    return BindStructLiteralExpression(nestedLiteral, nestedStructDef);
                }
            }

            // No collision (the nested type still holds its simple key): peel off
            // the redundant enclosing-type qualifier and bind the remainder by
            // simple name. This mirrors how the enclosing type's own members
            // reference a sibling nested type.
            if (IsNestedTypeOf(headIdentifier, enclosingAliasType))
            {
                return BindExpression(syntax.RightPart);
            }

            // Issue #2203: a type whose simple name equals the last segment of
            // its own containing package (e.g. `class Tokens` in `package
            // Oahu.Cli.Tui.Tokens`) is referenced from outside that package as
            // `Tokens.Tokens.Member` — mirroring the C# idiom where a nested
            // namespace is visible unqualified from a sibling namespace under a
            // shared ancestor, which cs2gs translates literally since G# has no
            // equivalent namespace-visibility rule. The leading "Tokens" plays
            // the namespace's role and is redundant (G# resolves the trailing
            // "Tokens" type by simple name from its flat, cross-package type
            // scope regardless), so peel it off the same way as the
            // nested-type case above whenever the qualifier names the type's own
            // simple name AND that name is also the tail of its package.
            if (headIdentifier == enclosingNameSyntax.IdentifierToken.Text
                && GetSymbolPackageName(enclosingAliasType) is string ownPackageName
                && (ownPackageName == headIdentifier || ownPackageName.EndsWith("." + headIdentifier, StringComparison.Ordinal)))
            {
                return BindExpression(syntax.RightPart);
            }
        }

        // Determine what the left side of the accessor is: either an imported
        // class (for static member access) or a value-producing expression (for
        // instance member access). Then apply the right side, which may itself
        // be a chain of accessors (e.g. Guid.NewGuid().ToString()).
        var leftPart = syntax.LeftPart;
        var rightPart = syntax.RightPart;
        BoundExpression receiver = null;
        ImportedClassSymbol classSymbol = null;
        EnumSymbol enumSymbol = null;
        StructSymbol userStructSymbol = null;
        InterfaceSymbol userInterfaceSymbol = null;

        if (leftPart is NameExpressionSyntax leftName)
        {
            var name = leftName.IdentifierToken.Text;
            var variableHit = scope.TryLookupSymbol(name) as VariableSymbol;

            // Issue #1104: `base.Prop` — a non-virtual read of the nearest base
            // class implementation of property `Prop`, mirroring C# `base.Prop`.
            // `base` is a contextual keyword: only intercepted when it is not a
            // real value in scope (so a hypothetical local named `base` still
            // wins).
            if (name == "base" && variableHit == null && rightPart is NameExpressionSyntax basePropName)
            {
                return BindBaseClassPropertyRead(basePropName, leftName.Location, explicitBaseType: null, selectorLocation: leftName.Location);
            }

            // Issue #1147 (Facet A — "Color Color" + unified overload
            // resolution): when the receiver name binds to BOTH an in-scope
            // value AND a same-named user struct/class, and the right-hand side
            // is a CALL to a method declared as BOTH an instance and a static
            // (`shared`) overload, neither the value nor the type interpretation
            // is correct on its own. Resolve the call against the COMBINED
            // instance + static overload set (C# §12.8.7.1) and route by the
            // selected method's IsStatic: an instance overload binds the VALUE
            // as the receiver; a static overload binds against the TYPE. This is
            // strictly scoped to the both-buckets-non-empty case, so a
            // static-only member name still falls through to the #687 type path
            // below and an instance-only name still falls through to the
            // value/instance path — both unchanged.
            if (variableHit != null
                && rightPart is CallExpressionSyntax colorColorCall
                && TryResolveColorColorType(name, leftName, out _, out var unifiedColorStruct, out _)
                && unifiedColorStruct != null
                && TryBindColorColorUnifiedCall(unifiedColorStruct, leftName, colorColorCall, out var unifiedColorResult))
            {
                return unifiedColorResult;
            }

            // Issue #687 (Option A — C#-style "color color"): when an identifier
            // resolves to both a value (field/local/parameter) AND a same-named
            // type in scope, prefer the type interpretation if the right-hand
            // side of the accessor is a static member of that type. Fall through
            // to the value interpretation otherwise so instance access continues
            // to bind as today (`field.InstanceMethod()`).
            if (variableHit != null
                && TryResolveColorColorType(name, leftName, out var colorClassSymbol, out var colorStructSymbol, out var colorEnumSymbol)
                && RightPartLooksLikeStaticMember(colorClassSymbol, colorStructSymbol, colorEnumSymbol, rightPart))
            {
                if (colorClassSymbol != null)
                {
                    classSymbol = colorClassSymbol;
                }
                else if (colorStructSymbol != null)
                {
                    userStructSymbol = colorStructSymbol;
                }
                else
                {
                    enumSymbol = colorEnumSymbol;
                }
            }
            else if (variableHit is VariableSymbol variable)
            {
                if (variable is ImplicitFieldVariableSymbol implicitField)
                {
                    // Bare field name inside a method: rebind as `this.field`
                    // so chained access (`Field.Sub`) emits a load of the
                    // backing field through the `this` receiver.
                    // Issue #186 / #175: implicit field as accessor receiver
                    // fires GS0204 if the field carries `@Obsolete`.
                    reportObsoleteUseIfApplicable(
                        leftName.IdentifierToken.Location,
                        implicitField.Field,
                        $"{implicitField.StructType.Name}.{implicitField.Field.Name}");

                    // Issue #208: apply any [MemberNotNull] narrowing so that
                    // chained access like `_name.Length` after a [MemberNotNull]
                    // call is accepted without a nil-guard.
                    receiver = BuildNarrowedRead(
                        new BoundFieldAccessExpression(
                            null,
                            new BoundVariableExpression(null, implicitField.Receiver),
                            implicitField.StructType,
                            implicitField.Field),
                        implicitField.Field.Type,
                        TryGetNarrowedType(implicitField),
                        nt => new BoundFieldAccessExpression(
                            null,
                            new BoundVariableExpression(null, implicitField.Receiver),
                            implicitField.StructType,
                            implicitField.Field,
                            nt));
                }
                else if (variable is ImplicitStaticFieldVariableSymbol implicitStaticField)
                {
                    // Issue #261: bare static field name as accessor receiver
                    // inside a shared method body.
                    reportObsoleteUseIfApplicable(
                        leftName.IdentifierToken.Location,
                        implicitStaticField.Field,
                        $"{implicitStaticField.OwnerName}.{implicitStaticField.Field.Name}");

                    // Issue #1030: an interface-owned static field carries its
                    // owning interface (self-instantiation for a generic
                    // interface) so emit/interpreter resolve it correctly.
                    receiver = implicitStaticField.InterfaceType != null
                        ? new BoundFieldAccessExpression(null, implicitStaticField.Field, implicitStaticField.InterfaceType)
                        : new BoundFieldAccessExpression(
                            null,
                            receiver: null,
                            implicitStaticField.StructType,
                            implicitStaticField.Field);
                }
                else if (variable is ImplicitStaticPropertyVariableSymbol implicitStaticProp)
                {
                    // ADR-0053: bare static property name as accessor receiver
                    // (e.g., `StaticProp.Sub` inside a method body of the
                    // enclosing type).
                    reportObsoleteUseIfApplicable(
                        leftName.IdentifierToken.Location,
                        implicitStaticProp.Property,
                        $"{implicitStaticProp.StructType.Name}.{implicitStaticProp.Property.Name}");

                    if (!implicitStaticProp.Property.HasGetter)
                    {
                        Diagnostics.ReportCannotAssign(leftName.IdentifierToken.Location, implicitStaticProp.Property.Name);
                        return new BoundErrorExpression(null);
                    }

                    receiver = new BoundPropertyAccessExpression(
                        null,
                        receiver: null,
                        implicitStaticProp.StructType,
                        implicitStaticProp.Property);
                }
                else if (variable is ImplicitPropertyVariableSymbol implicitProp)
                {
                    // Issue #1339: a bare instance-property name used as the
                    // receiver of a member access (`Prop.Member`, e.g.
                    // `Entries.Values`/`Items.Count`) must rebind as
                    // `this.Prop` so the getter call is emitted before the
                    // member access. Without this the property falls through to
                    // the bare-variable case below and emits as a load of a
                    // non-existent local slot named after the property (GS9998).
                    // Mirrors the static-property arm above and the standalone
                    // bare-name path in BindNameExpression.
                    reportObsoleteUseIfApplicable(
                        leftName.IdentifierToken.Location,
                        implicitProp.Property,
                        $"{implicitProp.StructType.Name}.{implicitProp.Property.Name}");

                    if (!implicitProp.Property.HasGetter)
                    {
                        Diagnostics.ReportCannotAssign(leftName.IdentifierToken.Location, implicitProp.Property.Name);
                        return new BoundErrorExpression(null);
                    }

                    receiver = new BoundPropertyAccessExpression(
                        null,
                        new BoundVariableExpression(null, implicitProp.Receiver),
                        implicitProp.StructType,
                        implicitProp.Property);
                }
                else
                {
                    receiver = BuildNarrowedRead(
                        new BoundVariableExpression(null, variable),
                        variable.Type,
                        TryGetNarrowedType(variable),
                        narrowed => new BoundVariableExpression(null, variable, narrowed));
                }
            }
            else if (scope.TryLookupImport(name, out var matchedImport)
                && TryBindImportAccessor(matchedImport, ref rightPart, out var typeFromImport))
            {
                classSymbol = typeFromImport;
            }
            else if (scope.TryLookupImport(name, out var matchedTypeAliasImport)
                && matchedTypeAliasImport.IsAlias
                && lookupType(name) is TypeSymbol aliasedType)
            {
                // Issue #2273: `import R = Namespace.Type` where the aliased
                // target is a same-compilation SOURCE type (a class/struct,
                // enum, or interface declared elsewhere in this compilation —
                // e.g. the conventional resx `import R = ...Properties.Resources`
                // pattern) rather than a CLR type. `TryBindImportAccessor` above
                // only resolves CLR alias targets via the reference resolver, so
                // a source-type alias falls through to here; `lookupType` (bound
                // to `Binder.LookupType`) now also resolves an alias's target
                // through the same import, so it recovers the aliased type
                // symbol directly.
                if (aliasedType is EnumSymbol foundAliasEnum)
                {
                    enumSymbol = foundAliasEnum;
                }
                else if (aliasedType is StructSymbol foundAliasStruct)
                {
                    userStructSymbol = foundAliasStruct;
                }
                else if (aliasedType is InterfaceSymbol foundAliasInterface)
                {
                    userInterfaceSymbol = foundAliasInterface;
                }
                else if (aliasedType.ClrType != null)
                {
                    classSymbol = new ImportedClassSymbol(aliasedType.ClrType, leftName, references: scope.References);
                }
                else
                {
                    Diagnostics.ReportUnableToFindType(leftName.Location, name);
                    return new BoundErrorExpression(null);
                }
            }
            else if (scope.TryLookupTypeAlias(name, out var typeAlias))
            {
                // Issue #2394: a same-compilation SOURCE type (enum/struct/
                // interface) must be checked BEFORE an imported CLR class so
                // that it wins when both are visible under the same simple
                // name. Imports are bound compilation-wide (not scoped per
                // file), so a same-simple-name CLR type imported via some
                // OTHER file could otherwise incorrectly shadow this
                // compilation's own type here — matching the precedence
                // already used by Binder.LookupType (type-clause position).
                if (typeAlias is EnumSymbol foundEnum)
                {
                    enumSymbol = foundEnum;
                }
                else if (typeAlias is StructSymbol foundStruct)
                {
                    userStructSymbol = foundStruct;
                }
                else if (typeAlias is InterfaceSymbol foundInterface)
                {
                    // ADR-0089 / issue #1030: `IName.StaticField` — qualified
                    // access to an interface static field (storage or const).
                    userInterfaceSymbol = foundInterface;
                }
                else
                {
                    Diagnostics.ReportUnableToFindType(leftName.Location, name);
                    return new BoundErrorExpression(null);
                }
            }
            else if (scope.TryLookupImportedClass(name, leftName, out var importedClass))
            {
                classSymbol = importedClass;
            }
            else if (binderCtx.CurrentTypeParameters != null
                && binderCtx.CurrentTypeParameters.TryGetValue(name, out var tpSym))
            {
                // ADR-0089 / issue #755: `T.Member(args)` where `T` is a
                // generic type parameter with an interface constraint
                // dispatches to a static-virtual interface member. We
                // delegate to a helper that resolves the rightPart against
                // the constraint interface's static-virtual table.
                return BindTypeParameterStaticAccessorStep(tpSym, leftName, rightPart);
            }
            else if (TryResolvePredefinedTypeReceiver(name, leftName, out var predefinedClass))
            {
                // Issue #919: a lowercase predefined primitive type alias used as
                // the receiver of a static member access (e.g. `string.Empty`,
                // `int32.MaxValue`). The earlier import/alias lookups only match
                // the capitalized CLR name (`String`, `Int32`); the keyword form
                // is resolved here to the same underlying CLR type so static
                // member access binds identically to the capitalized form.
                classSymbol = predefinedClass;
            }
            else if (rightPart is not NameExpressionSyntax
                && TryBindFullyQualifiedClrStaticAccess(leftName, ref rightPart, out var fullyQualifiedClrClass))
            {
                // Issue #2258: a fully-qualified CLR type reference whose leading
                // segment is not a registered import — e.g.
                // `Microsoft.Extensions.Logging.LogLevel.Warning`. cs2gs emits the
                // full namespace path; walk it to the referenced CLR type and bind
                // the trailing member as a static access. Gated on the right part
                // being a further chain (not a bare terminal name) so a genuine
                // undefined single-segment name still reports GS0157 below.
                classSymbol = fullyQualifiedClrClass;
            }
            else
            {
                Diagnostics.ReportUnableToFindType(leftName.Location, name);
                return new BoundErrorExpression(null);
            }
        }
        else if (leftPart is IndexExpressionSyntax genericTypeIndex
            && !genericTypeIndex.IsNullConditional
            && TryResolveConstructedGenericTypeReceiver(
                genericTypeIndex,
                out var constructedStruct,
                out var constructedInterface,
                out var constructedImported))
        {
            // Issue #1209 (extends ADR-0089 / issue #1030): a generic-type
            // reference with explicit type arguments used in expression /
            // member-access receiver position — `Box[int32].Default`,
            // `ArrayPool[uint8].Shared`, `Comparer[int32].Default`. The parser
            // shapes `Name[Arg]` as an index expression; when `Name` is NOT a
            // value but IS a generic type definition of matching arity (user
            // class/struct, user interface, or imported CLR generic), bind the
            // whole `Name[Arg]` as the constructed generic *type* receiver
            // rather than as element access. The closed construction is carried
            // so static-member access (and static method calls) resolve against
            // the construction.
            if (constructedInterface != null)
            {
                userInterfaceSymbol = constructedInterface;
            }
            else if (constructedStruct != null)
            {
                userStructSymbol = constructedStruct;
            }
            else
            {
                classSymbol = constructedImported;
            }
        }
        else if (leftPart is GenericNameExpressionSyntax genericTypeName
            && TryResolveConstructedGenericTypeReceiver(
                genericTypeName,
                out var genericConstructedStruct,
                out var genericConstructedInterface,
                out var genericConstructedImported))
        {
            // Issue #1323: a constructed generic *type* reference used as a
            // member-access receiver where the type argument is unambiguously a
            // type (`Box[int32?].Make(5)`, `Box[[]int32].Make(5)`,
            // `Box[List[int32]].Make(5)`, `Pair[int, string].Default`). The
            // parser emits a GenericNameExpression here (the bracket contents
            // cannot be reshaped from an index expression), so bind the closed
            // construction directly as the static-access receiver.
            if (genericConstructedInterface != null)
            {
                userInterfaceSymbol = genericConstructedInterface;
            }
            else if (genericConstructedStruct != null)
            {
                userStructSymbol = genericConstructedStruct;
            }
            else
            {
                classSymbol = genericConstructedImported;
            }
        }
        else if (leftPart is AccessorExpressionSyntax qualifiedNestedType
            && !qualifiedNestedType.IsNullConditional
            && TryResolveQualifiedUserNestedType(qualifiedNestedType, out var qualifiedNestedSymbol))
        {
            // Issue #1069: a qualified nested *type* used as the receiver of a
            // further member access, e.g. `Outer.Color.Red` (the `Outer.Color`
            // sub-chain names the nested enum) or `Outer.Inner.StaticMember`.
            switch (qualifiedNestedSymbol)
            {
                case EnumSymbol qualifiedEnum:
                    enumSymbol = qualifiedEnum;
                    break;
                case StructSymbol qualifiedStruct:
                    userStructSymbol = qualifiedStruct;
                    break;
                case InterfaceSymbol qualifiedInterface:
                    userInterfaceSymbol = qualifiedInterface;
                    break;
                default:
                    receiver = BindExpression(leftPart);
                    break;
            }
        }
        else if (leftPart is AccessorExpressionSyntax inheritedImportedNestedType
            && !inheritedImportedNestedType.IsNullConditional
            && TryResolveInheritedImportedNestedType(inheritedImportedNestedType, out var inheritedImportedNestedSymbol))
        {
            classSymbol = inheritedImportedNestedSymbol;
        }
        else if (leftPart is IndexExpressionSyntax nestedTypeIndex
            && !nestedTypeIndex.IsNullConditional
            && TryResolveUserNestedTypeExpression(nestedTypeIndex, out var nestedTypeIndexSymbol))
        {
            // Issue #1537: a per-segment generic nested-type chain whose deepest
            // segment carries a SINGLE type argument parses as an index over the
            // preceding accessor (`Outer[int32].Middle[string]` is
            // `((Outer[int32]).Middle)[string]`), so it never reaches the
            // NAME-target index branch above. Resolve it as the constructed
            // nested type receiver (`Outer`1+Middle`2<int32, string>`) so the
            // trailing member access / composite literal binds against a type
            // whose members substitute every enclosing level.
            switch (nestedTypeIndexSymbol)
            {
                case EnumSymbol nestedIndexEnum:
                    enumSymbol = nestedIndexEnum;
                    break;
                case StructSymbol nestedIndexStruct:
                    userStructSymbol = nestedIndexStruct;
                    break;
                case InterfaceSymbol nestedIndexInterface:
                    userInterfaceSymbol = nestedIndexInterface;
                    break;
                default:
                    receiver = BindExpression(leftPart);
                    break;
            }
        }
        else
        {
            receiver = BindExpression(leftPart);
        }

        if (enumSymbol != null)
        {
            return BindEnumAccessorStep(enumSymbol, rightPart);
        }

        if (userStructSymbol != null)
        {
            return BindUserTypeStaticAccessorStep(userStructSymbol, rightPart);
        }

        if (userInterfaceSymbol != null)
        {
            return BindInterfaceStaticAccessorStep(userInterfaceSymbol, rightPart);
        }

        return BindAccessorStep(receiver, classSymbol, rightPart);
    }

    private bool TryResolveInheritedImportedNestedType(
        AccessorExpressionSyntax syntax,
        out ImportedClassSymbol nestedClassSymbol)
    {
        nestedClassSymbol = null;
        StructSymbol sourceType = null;
        if (syntax.LeftPart is NameExpressionSyntax sourceName
            && scope.TryLookupTypeAlias(sourceName.IdentifierToken.Text, out var sourceAlias)
            && sourceAlias is StructSymbol namedSourceType)
        {
            sourceType = namedSourceType;
        }
        else if (syntax.LeftPart is IndexExpressionSyntax constructedSource
            && TryResolveConstructedGenericTypeReceiver(
                constructedSource,
                out var constructedStruct,
                out _,
                out _))
        {
            sourceType = constructedStruct;
        }
        else if (syntax.LeftPart is GenericNameExpressionSyntax genericSource
            && TryResolveConstructedGenericTypeReceiver(
                genericSource,
                out var genericStruct,
                out _,
                out _))
        {
            sourceType = genericStruct;
        }

        if (sourceType == null
            || TypeMemberModel.GetNearestImportedBase(sourceType)?.ClrType is not Type importedBase)
        {
            return false;
        }

        var importedBaseSymbol = new ImportedClassSymbol(importedBase, syntax.LeftPart, references: scope.References);
        if (!TryResolveNestedTypeFromAccessorLeft(importedBaseSymbol, syntax.RightPart, out nestedClassSymbol))
        {
            return false;
        }

        nestedClassSymbol = CloseImportedNestedType(importedBase, nestedClassSymbol, syntax.RightPart);
        return true;
    }

    private ImportedClassSymbol CloseImportedNestedType(
        Type constructedOuter,
        ImportedClassSymbol nested,
        ExpressionSyntax syntax)
    {
        var nestedType = nested?.ClassType;
        if (constructedOuter?.IsConstructedGenericType != true
            || nestedType?.ContainsGenericParameters != true)
        {
            return nested;
        }

        var outerArguments = constructedOuter.GetGenericArguments();
        if (nestedType.GetGenericArguments().Length != outerArguments.Length)
        {
            return nested;
        }

        try
        {
            return new ImportedClassSymbol(nestedType.MakeGenericType(outerArguments), syntax, references: scope.References);
        }
        catch (ArgumentException)
        {
            return nested;
        }
    }

    /// <summary>
    /// Issue #1069: returns the enclosing (containing) type of a user-defined
    /// nested type symbol, or <see langword="null"/> for a top-level type or a
    /// kind that cannot be nested.
    /// </summary>
    private static TypeSymbol GetSymbolContainingType(TypeSymbol type) => type switch
    {
        StructSymbol s => s.ContainingType,
        EnumSymbol e => e.ContainingType,
        InterfaceSymbol i => i.ContainingType,
        _ => null,
    };

    /// <summary>
    /// Issue #2203: returns the dotted package name a user-defined aggregate
    /// type was declared in, or <see langword="null"/> for a kind that has no
    /// package (or isn't a user aggregate type at all).
    /// </summary>
    private static string GetSymbolPackageName(TypeSymbol type) => type switch
    {
        StructSymbol s => s.PackageName,
        EnumSymbol e => e.PackageName,
        InterfaceSymbol i => i.PackageName,
        _ => null,
    };

    /// <summary>
    /// Issue #1069: a user-defined aggregate type (class/struct, enum, or
    /// interface) declared in the current compilation, as opposed to an imported
    /// CLR type or a predefined primitive alias.
    /// </summary>
    private static bool IsUserAggregateType(TypeSymbol type) =>
        type is StructSymbol or EnumSymbol or InterfaceSymbol;

    /// <summary>
    /// Issue #1213: whether the function currently being bound belongs to
    /// <paramref name="type"/> (or a type derived from it). Used to gate
    /// in-type resolution of a field-like event to its private backing
    /// delegate field, matching C# (an event name in expression position is
    /// only valid inside the declaring type).
    /// </summary>
    private bool IsWithinType(StructSymbol type)
    {
        if (type == null)
        {
            return false;
        }

        var enclosingType = (this.function?.ReceiverType as StructSymbol)
            ?? (this.function?.StaticOwnerType as StructSymbol);

        for (var t = enclosingType; t != null; t = t.BaseClass)
        {
            if (ReferenceEquals(t, type)
                || (t.Declaration != null && ReferenceEquals(t.Declaration, type.Declaration)))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #1069: whether <paramref name="name"/> resolves to a user-defined
    /// type whose enclosing type is <paramref name="container"/>.
    /// </summary>
    private bool IsNestedTypeOf(string name, TypeSymbol container) =>
        scope.TryLookupTypeAlias(name, out var candidate)
        && IsUserAggregateType(candidate)
        && ReferenceEquals(GetSymbolContainingType(candidate), container);

    /// <summary>
    /// Issue #1069: returns the leftmost identifier of an accessor-chain segment
    /// (the head of a call, index, accessor, or bare name), used to detect when a
    /// qualified reference targets a nested type by its simple name.
    /// </summary>
    private static bool TryGetHeadIdentifier(ExpressionSyntax expression, out string identifier)
    {
        switch (expression)
        {
            case NameExpressionSyntax name:
                identifier = name.IdentifierToken.Text;
                return true;
            case CallExpressionSyntax call:
                identifier = call.Identifier.Text;
                return true;
            case AccessorExpressionSyntax accessor:
                return TryGetHeadIdentifier(accessor.LeftPart, out identifier);
            case IndexExpressionSyntax index:
                return TryGetHeadIdentifier(index.Target, out identifier);
            case StructLiteralExpressionSyntax structLiteral:
                identifier = structLiteral.TypeIdentifier.Text;
                return true;
            case ObjectCreationExpressionSyntax objectCreation:
                return TryGetHeadIdentifier(objectCreation.Target, out identifier);
            default:
                identifier = null;
                return false;
        }
    }

    /// <summary>
    /// Issue #1069: resolves a dotted accessor of the form
    /// <c>Outer.Nested</c> (optionally deeper, <c>A.B.C</c>) to the user-defined
    /// nested type it names, by walking the enclosing-type chain. Each segment
    /// after the first must name a user type whose enclosing type is the symbol
    /// resolved for the preceding segment. Returns <see langword="false"/> when
    /// the chain is not a pure user nested-type reference.
    /// </summary>
    private bool TryResolveQualifiedUserNestedType(AccessorExpressionSyntax accessor, out TypeSymbol nestedType)
        => TryResolveUserNestedTypeExpression(accessor, out nestedType);

    /// <summary>
    /// Issue #942/#1537: returns the leftmost (root) identifier of a candidate
    /// user-type-naming chain — the head of a bare name, generic name,
    /// per-segment index, or accessor — WITHOUT binding any bracketed contents.
    /// Used to gate the nested-type-chain probe on the head naming a user
    /// aggregate TYPE before any bracket is speculatively bound as a type
    /// argument, so a genuine indexer whose index is an identifier
    /// (<c>xs[i]</c>) is never probed as a constructed nested type. Mirrors the
    /// shapes accepted by <see cref="TryFlattenUserTypeExpressionSegments"/> so
    /// the gate never rejects a chain the core would otherwise flatten.
    /// </summary>
    /// <param name="expr">The candidate type-naming expression.</param>
    /// <param name="headName">The resolved root identifier on success.</param>
    /// <returns>Whether a root identifier could be extracted.</returns>
    private static bool TryGetUserTypeChainHead(ExpressionSyntax expr, out string headName)
    {
        switch (expr)
        {
            case NameExpressionSyntax name:
                headName = name.IdentifierToken.Text;
                return true;
            case GenericNameExpressionSyntax generic:
                headName = generic.Identifier.Text;
                return true;
            case IndexExpressionSyntax index when !index.IsNullConditional:
                return TryGetUserTypeChainHead(index.Target, out headName);
            case AccessorExpressionSyntax accessor when !accessor.IsNullConditional:
                return TryGetUserTypeChainHead(accessor.LeftPart, out headName);
            default:
                headName = null;
                return false;
        }
    }

    /// <summary>
    /// Issue #1069/#1506/#1521/#1537: resolves an expression that names a
    /// (possibly nested, possibly per-segment generic) user type — e.g.
    /// <c>Outer.Middle</c>, <c>Outer[int32].Middle</c>,
    /// <c>Outer[int32].Middle[string]</c>, or the arbitrarily deep
    /// <c>Outer[int32].Middle[string].Inner[bool]</c> — to its constructed type
    /// symbol. The chain is flattened to per-segment (name, own type-arguments)
    /// pairs, each segment is resolved as a nested type of the previous one, and
    /// the deepest segment is constructed threading BOTH the flattened enclosing
    /// construction's arguments (outermost-first, occupying the low ordinals)
    /// and its own arguments, so member lookup substitutes every level and the
    /// emitter encodes the reified nested type (<c>Outer`1+Middle`2&lt;int32,
    /// string&gt;</c>). Generalizes to arbitrary depth and mixed generic /
    /// non-generic levels; a fully non-generic chain returns the definition
    /// unchanged (preserving #1069 behavior).
    /// </summary>
    /// <param name="expr">The type-naming expression (accessor or index chain).</param>
    /// <param name="nestedType">The resolved (possibly constructed) type symbol.</param>
    /// <returns>Whether the expression resolved to a user nested type.</returns>
    private bool TryResolveUserNestedTypeExpression(ExpressionSyntax expr, out TypeSymbol nestedType)
    {
        nestedType = null;

        // Issue #942 regression guard: this probe speculatively binds each
        // bracketed segment's contents as TYPE arguments to decide whether
        // `expr` names a constructed nested type (#1537) rather than an indexer
        // receiver. In a genuine per-segment nested-type chain the ROOT names a
        // user aggregate TYPE (`Outer` in `Outer[int32].Middle[string]`); in a
        // real indexer the root is a VALUE — a local/parameter/field such as
        // `xs` in `xs[i]`. Gate on the head naming a user aggregate type (and
        // NOT a value) BEFORE binding any bracket as a type — mirroring
        // TryResolveConstructedGenericTypeReceiver — so a real indexer whose
        // index is an identifier is never probed as a nested type (which would
        // look the index up as a type and report a spurious GS0113).
        if (!TryGetUserTypeChainHead(expr, out var headName)
            || scope.TryLookupSymbol(headName) is VariableSymbol
            || !scope.TryLookupTypeAlias(headName, out var headCandidate)
            || !IsUserAggregateType(headCandidate))
        {
            return false;
        }

        return TryResolveUserNestedTypeExpressionCore(expr, out nestedType);
    }

    /// <summary>
    /// Issue #1537: the flatten-and-construct core of
    /// <see cref="TryResolveUserNestedTypeExpression"/>. Invoked only after the
    /// wrapper has confirmed the chain head names a user aggregate type, so the
    /// speculative type-argument binding it performs cannot mistake a genuine
    /// indexer receiver for a nested-type chain.
    /// </summary>
    /// <param name="expr">The type-naming expression (accessor or index chain).</param>
    /// <param name="nestedType">The resolved (possibly constructed) type symbol.</param>
    /// <returns>Whether the expression resolved to a user nested type.</returns>
    private bool TryResolveUserNestedTypeExpressionCore(ExpressionSyntax expr, out TypeSymbol nestedType)
    {
        nestedType = null;
        var segments = new List<(string Name, ImmutableArray<TypeSymbol> Args)>();
        if (!TryFlattenUserTypeExpressionSegments(expr, segments) || segments.Count < 2)
        {
            return false;
        }

        var headArity = segments[0].Args.IsDefaultOrEmpty ? -1 : segments[0].Args.Length;
        if (!scope.TryLookupTypeAlias(segments[0].Name, headArity, out var headDef) || !IsUserAggregateType(headDef))
        {
            return false;
        }

        var definitions = new TypeSymbol[segments.Count];
        definitions[0] = headDef;
        for (var i = 1; i < segments.Count; i++)
        {
            var containerDef = (definitions[i - 1] as StructSymbol)?.Definition ?? definitions[i - 1];
            var arity = segments[i].Args.IsDefaultOrEmpty ? -1 : segments[i].Args.Length;
            if (scope.TryLookupNestedTypeAlias(containerDef, segments[i].Name, arity, out var nested))
            {
                definitions[i] = nested;
            }
            else if (definitions[i - 1] is StructSymbol containerStruct
                && scope.TryLookupNestedTypeAliasIncludingInherited(containerStruct, segments[i].Name, arity, out var inheritedNested, out var declaringContainer))
            {
                definitions[i - 1] = declaringContainer;
                definitions[i] = inheritedNested;
            }
            else
            {
                return false;
            }
        }

        // Thread the flattened enclosing construction's arguments (the own
        // arguments of every generic enclosing segment, outermost-first) onto
        // the deepest segment, together with its own arguments. A generic
        // enclosing segment left without matching arguments cannot be threaded,
        // so the whole chain stays open (mirrors the type-clause path's
        // CollectConstructedEnclosingArguments).
        var enclosingBuilder = ImmutableArray.CreateBuilder<TypeSymbol>();
        for (var i = 0; i < segments.Count - 1; i++)
        {
            var ownParams = definitions[i] switch
            {
                StructSymbol s => (s.Definition ?? s).TypeParameters,
                InterfaceSymbol iface => (iface.Definition ?? iface).TypeParameters,
                _ => ImmutableArray<TypeParameterSymbol>.Empty,
            };

            if (ownParams.IsDefaultOrEmpty)
            {
                continue;
            }

            var constructionArgs = definitions[i] is StructSymbol constructedStruct
                && !constructedStruct.TypeArguments.IsDefaultOrEmpty
                ? constructedStruct.TypeArguments
                : segments[i].Args;
            if (constructionArgs.IsDefaultOrEmpty || constructionArgs.Length != ownParams.Length)
            {
                enclosingBuilder = null;
                break;
            }

            if (definitions[i] is StructSymbol nestedConstruction
                && !nestedConstruction.EnclosingTypeArguments.IsDefaultOrEmpty)
            {
                enclosingBuilder.AddRange(nestedConstruction.EnclosingTypeArguments);
            }

            enclosingBuilder.AddRange(constructionArgs);
        }

        var enclosingArgs = enclosingBuilder != null && enclosingBuilder.Count > 0
            ? enclosingBuilder.ToImmutable()
            : default;
        var ownArgs = segments[segments.Count - 1].Args;

        switch (definitions[segments.Count - 1])
        {
            case StructSymbol nestedStruct:
                var def = nestedStruct.Definition ?? nestedStruct;
                if (!enclosingArgs.IsDefaultOrEmpty && !ownArgs.IsDefaultOrEmpty)
                {
                    nestedType = StructSymbol.ConstructNestedGeneric(def, enclosingArgs, ownArgs, scope.References.MapClrTypeToReferences);
                }
                else if (!enclosingArgs.IsDefaultOrEmpty)
                {
                    nestedType = StructSymbol.ConstructNested(def, enclosingArgs, scope.References.MapClrTypeToReferences);
                }
                else if (!ownArgs.IsDefaultOrEmpty)
                {
                    nestedType = StructSymbol.Construct(def, ownArgs, scope.References.MapClrTypeToReferences);
                }
                else
                {
                    nestedType = def;
                }

                return true;

            case InterfaceSymbol nestedIface:
                var ifaceDef = nestedIface.Definition ?? nestedIface;
                nestedType = !ownArgs.IsDefaultOrEmpty
                    ? InterfaceSymbol.Construct(ifaceDef, ownArgs, scope.References.MapClrTypeToReferences)
                    : ifaceDef;
                return true;

            default:
                nestedType = definitions[segments.Count - 1];
                return true;
        }
    }

    /// <summary>
    /// Issue #1537: flattens a user-type-naming expression into its ordered
    /// per-segment (simple name, bound own type-arguments) pairs. Because
    /// per-segment generics parse as an index over the preceding accessor
    /// (<c>Outer[int32].Middle[string]</c> is
    /// <c>((Outer[int32]).Middle)[string]</c>) and multi-argument segments parse
    /// as generic-name expressions, every shape (name, generic-name, index,
    /// accessor) is handled so arbitrary depth and arity flatten uniformly.
    /// </summary>
    /// <param name="expr">The type-naming expression.</param>
    /// <param name="segments">The accumulator for resolved segments (outermost-first).</param>
    /// <returns>Whether the expression is a well-formed user-type name chain.</returns>
    private bool TryFlattenUserTypeExpressionSegments(ExpressionSyntax expr, List<(string Name, ImmutableArray<TypeSymbol> Args)> segments)
    {
        // Issue #942 regression guard: flattening speculatively binds each
        // bracketed segment's contents as TYPE arguments. When the expression is
        // NOT a well-formed user-type name chain (e.g. a genuine indexer whose
        // index is a value), that speculative bind can report a type diagnostic
        // (GS0113) even though this probe ultimately returns false and the caller
        // falls back to normal binding. Snapshot the diagnostic bag and roll it
        // back on failure so the probe is side-effect-free for ANY chain shape.
        var diagMark = Diagnostics.Count;
        if (TryFlattenUserTypeExpressionSegmentsCore(expr, segments))
        {
            return true;
        }

        Diagnostics.TruncateTo(diagMark);
        return false;
    }

    /// <summary>
    /// Issue #1537: the recursive core of
    /// <see cref="TryFlattenUserTypeExpressionSegments"/>. The wrapper snapshots
    /// and rolls back the diagnostic bag around this method so a failed probe
    /// never leaks the speculative type-argument-binding diagnostics it emits.
    /// </summary>
    /// <param name="expr">The type-naming expression.</param>
    /// <param name="segments">The accumulator for resolved segments (outermost-first).</param>
    /// <returns>Whether the expression is a well-formed user-type name chain.</returns>
    private bool TryFlattenUserTypeExpressionSegmentsCore(ExpressionSyntax expr, List<(string Name, ImmutableArray<TypeSymbol> Args)> segments)
    {
        switch (expr)
        {
            case NameExpressionSyntax name:
                segments.Add((name.IdentifierToken.Text, default));
                return true;

            case GenericNameExpressionSyntax generic:
                if (!TryBindGenericSegmentArguments(generic, out var genericArgs))
                {
                    return false;
                }

                segments.Add((generic.Identifier.Text, genericArgs));
                return true;

            case IndexExpressionSyntax index when !index.IsNullConditional:
                if (index.Target is NameExpressionSyntax indexTargetName)
                {
                    if (!TryBindTypeArgumentExpressions(index.Index, out var rootArgs))
                    {
                        return false;
                    }

                    segments.Add((indexTargetName.IdentifierToken.Text, rootArgs));
                    return true;
                }

                if (!TryFlattenUserTypeExpressionSegments(index.Target, segments) || segments.Count == 0)
                {
                    return false;
                }

                var last = segments[segments.Count - 1];
                if (!last.Args.IsDefaultOrEmpty)
                {
                    return false;
                }

                if (!TryBindTypeArgumentExpressions(index.Index, out var lastArgs))
                {
                    return false;
                }

                segments[segments.Count - 1] = (last.Name, lastArgs);
                return true;

            case AccessorExpressionSyntax accessor when !accessor.IsNullConditional:
                if (!TryFlattenUserTypeExpressionSegments(accessor.LeftPart, segments))
                {
                    return false;
                }

                switch (accessor.RightPart)
                {
                    case NameExpressionSyntax rightName:
                        segments.Add((rightName.IdentifierToken.Text, default));
                        return true;
                    case GenericNameExpressionSyntax rightGeneric
                        when TryBindGenericSegmentArguments(rightGeneric, out var rightArgs):
                        segments.Add((rightGeneric.Identifier.Text, rightArgs));
                        return true;
                    default:
                        return false;
                }

            default:
                return false;
        }
    }

    /// <summary>
    /// Issue #1537: binds the type-argument clauses of a generic-name segment
    /// (<c>Middle[string]</c>) to their type symbols for nested-type chain
    /// resolution in expression position.
    /// </summary>
    /// <param name="generic">The generic-name segment.</param>
    /// <param name="typeArgs">The bound type arguments on success.</param>
    /// <returns>Whether all type-argument clauses bound successfully.</returns>
    private bool TryBindGenericSegmentArguments(GenericNameExpressionSyntax generic, out ImmutableArray<TypeSymbol> typeArgs)
    {
        typeArgs = default;
        var argClauses = generic.TypeArgumentList.Arguments;
        var builder = ImmutableArray.CreateBuilder<TypeSymbol>(argClauses.Count);
        foreach (var clause in argClauses)
        {
            var bound = bindTypeClause(clause);
            if (bound == null)
            {
                return false;
            }

            builder.Add(bound);
        }

        typeArgs = builder.ToImmutable();
        return true;
    }

    /// <summary>
    /// Issue #919: resolves a lowercase predefined primitive type alias used as
    /// the receiver of a static member access (e.g. <c>string.Empty</c>,
    /// <c>int32.MaxValue</c>, <c>object.ReferenceEquals(...)</c>) to an
    /// <see cref="ImportedClassSymbol"/> over its underlying CLR type.
    /// </summary>
    /// <remarks>
    /// This runs only after the import/alias/imported-class lookups have failed,
    /// so it never shadows a user alias or an imported type. The keyword aliases
    /// (<c>string</c>, <c>int32</c>, <c>bool</c>, ...) are reserved names that
    /// cannot be redeclared, so resolving them here is unambiguous and mirrors
    /// the capitalized CLR-name form (<c>String</c>, <c>Int32</c>) that already
    /// binds through <see cref="BoundScope.TryLookupImportedClass"/>.
    /// </remarks>
    /// <param name="name">The identifier text written as the accessor receiver.</param>
    /// <param name="declaration">The receiver name syntax (for symbol provenance).</param>
    /// <param name="classSymbol">The resolved CLR class symbol on success.</param>
    /// <returns><see langword="true"/> when <paramref name="name"/> is a predefined primitive alias with a backing CLR type.</returns>
    private bool TryResolvePredefinedTypeReceiver(string name, ExpressionSyntax declaration, out ImportedClassSymbol classSymbol)
    {
        classSymbol = null;

        var typeSymbol = lookupType(name);

        // Only genuine predefined primitive aliases carry a non-null ClrType and
        // are not already handled by an earlier branch. User struct/enum aliases
        // (resolved by TryLookupTypeAlias) have a null ClrType and are excluded.
        // `void` has a CLR type but is meaningless as a static-access receiver, so
        // exclude it and let the normal "cannot find type" diagnostic apply.
        if (typeSymbol == null
            || typeSymbol.ClrType == null
            || ReferenceEquals(typeSymbol, TypeSymbol.Void))
        {
            return false;
        }

        classSymbol = new ImportedClassSymbol(typeSymbol.ClrType, declaration, references: scope.References);
        return true;
    }

    private BoundExpression BindNullConditionalAccessExpression(AccessorExpressionSyntax syntax)
    {
        var receiver = BindExpression(syntax.LeftPart);
        if (receiver is BoundErrorExpression)
        {
            return receiver;
        }

        return BindNullConditionalAccessExpressionCore(receiver, syntax.RightPart);
    }

    private BoundExpression BindNullConditionalAccessExpressionCore(BoundExpression receiver, ExpressionSyntax rightPart)
    {
        var receiverType = receiver.Type;
        TypeSymbol underlying;
        if (receiverType is NullableTypeSymbol nullable)
        {
            underlying = nullable.UnderlyingType;
        }
        else if (receiverType == TypeSymbol.Null)
        {
            // `nil?.x` is statically nil.
            return new BoundLiteralExpression(null, null);
        }
        else
        {
            // Non-nullable receiver: `?.` collapses to `.`, but we still
            // produce a nullable result type for syntactic consistency.
            underlying = receiverType;
        }

        // Create a synthetic capture local. Name is not user-visible; we
        // include a leading `$` so it cannot collide with user identifiers.
        var captureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: underlying);

        // Bind the access using the capture as the receiver. We push a temp
        // scope so the capture is in scope for any nested name lookup that
        // happens during access binding (defensive — current accessor paths
        // don't look up the receiver by name).
        scope = new BoundScope(scope);
        scope.TryDeclareVariable(capture);

        var captureRef = new BoundVariableExpression(null, capture);
        var whenNotNull = BindAccessorStep(captureRef, null, rightPart);

        scope = scope.Parent;

        // Issue #1213: a null-conditional invocation whose access produces no
        // value — the canonical event-raise form `evt?.Invoke(args)` where the
        // delegate returns `void` — is itself a `void` statement. Do not wrap
        // `void` in a nullable result type; that would force the emitter to
        // push a `null` on the nil branch with nothing to match it on the
        // not-null branch (a stack-imbalance). The emitter special-cases a
        // `void`-typed null-conditional to a plain null-guarded call.
        if (ReferenceEquals(whenNotNull.Type, TypeSymbol.Void))
        {
            return new BoundNullConditionalAccessExpression(null, receiver, capture, whenNotNull, TypeSymbol.Void, resultSlot: null);
        }

        var resultType = whenNotNull.Type is NullableTypeSymbol ? whenNotNull.Type : (TypeSymbol)NullableTypeSymbol.Get(whenNotNull.Type);

        // P2-7 / Issue #421: when the access result is a value type, the
        // bound result type is `Nullable<T>` but the not-null branch pushes
        // a raw `T` and the nil branch would push `null`. The emitter needs
        // a typed temp slot to materialize `default(Nullable<T>)` for the
        // nil branch (initobj) and to host the wrapped value for the
        // not-null branch (newobj `Nullable<T>::.ctor(!0)`). We allocate
        // that synthetic slot here so the emit pre-pass can give it a
        // local index alongside the capture local.
        //
        // ADR-0073 / issue #710: chained `?.`/`?[]` can yield a
        // `WhenNotNull` that is itself already a `Nullable<T>`. In that
        // case both branches still need to leave a Nullable<T> on the
        // stack, so we MUST allocate the slot whenever the *result type's
        // underlying* is a value type — even if `whenNotNull.Type` is
        // already nullable. The emitter inspects `WhenNotNull.Type` to
        // decide whether to wrap with `newobj` or pass through.
        //
        // Issue #1475: the slot must be allocated for ANY value-type
        // underlying recognised by SYMBOL — user `EnumSymbol`, value-type
        // `StructSymbol`, a value-constrained type parameter, tuple — not only
        // when the underlying carries a runtime `ClrType.IsValueType`. User
        // enums/structs have a null `ClrType`, so the old gate skipped them and
        // emit fell to the reference (`ldnull`) branch, producing unverifiable
        // IL (`StackUnexpected`/`PathStackUnexpected`). Routing through the
        // canonical symbol-level value-type predicate keeps BCL behaviour
        // identical while covering user value types.
        LocalVariableSymbol resultSlot = null;
        if (resultType is NullableTypeSymbol nullableResult
            && GSharp.Core.CodeAnalysis.Emit.ReflectionMetadataEmitter.IsValueTypeSymbol(nullableResult.UnderlyingType))
        {
            var resultSlotName = "$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(System.Globalization.CultureInfo.InvariantCulture);
            resultSlot = new LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType);
        }

        return new BoundNullConditionalAccessExpression(null, receiver, capture, whenNotNull, resultType, resultSlot);
    }

    private bool TryBindImportAccessor(ImportSymbol import, ref ExpressionSyntax rightPart, out ImportedClassSymbol importedClass)
    {
        // Handle `<importName>.<Segment>(.<Segment>)*.<TypeName>(.<more>)*` where
        // <importName> is either an alias or the import's path. Walks the accessor
        // chain extending the namespace prefix until a segment resolves as a type;
        // unresolved leading segments are treated as additional namespace levels
        // (issue #687: e.g. `System.IO.Path.Combine(...)` with `import System.IO`
        // peels `IO` as a namespace continuation, then resolves `System.IO.Path`).
        importedClass = null;

        var currentPath = import.Target;

        // A type alias (`import R = System.Console`) names a type outright: the
        // import target itself resolves as a type, and the accessor's right part
        // is a *static member* of it (`R.WriteLine`, `R.EncryptedFileExt`) rather
        // than a further namespace/type segment. Resolve the target as a type
        // first and leave the right part unconsumed so the caller binds it as the
        // member access on the aliased type. (A plain namespace import target does
        // not resolve as a type, so the segment-walk below still owns that case.)
        if (scope.References.TryResolveType(currentPath, out var aliasTargetType))
        {
            importedClass = new ImportedClassSymbol(aliasTargetType, rightPart, references: scope.References);
            return true;
        }

        return TryWalkQualifiedClrTypePath(currentPath, ref rightPart, out importedClass);
    }

    /// <summary>
    /// Issue #2258: last-resort fallback for a fully-qualified CLR type reference
    /// written in expression position whose leading segment is NOT a registered
    /// import/alias — e.g. <c>Microsoft.Extensions.Logging.LogLevel.Warning</c>
    /// (CLR enum member) or
    /// <c>Microsoft.Extensions.Logging.Abstractions.NullLoggerFactory.Instance</c>
    /// (CLR static field). cs2gs fully-qualifies every type reference, so a
    /// referenced-assembly type accessed by its full namespace path lands here
    /// when the root namespace segment (<c>Microsoft</c>) matches no import.
    /// Walks the dotted chain the same way <see cref="TryBindImportAccessor"/>
    /// does, but starting from the bare leading name as the first namespace
    /// segment, so any referenced CLR type — regardless of namespace depth —
    /// resolves and its trailing member binds as a static access.
    /// </summary>
    private bool TryBindFullyQualifiedClrStaticAccess(NameExpressionSyntax leftName, ref ExpressionSyntax rightPart, out ImportedClassSymbol importedClass)
        => TryWalkQualifiedClrTypePath(leftName.IdentifierToken.Text, ref rightPart, out importedClass);

    /// <summary>
    /// Walks a dotted accessor chain, extending a namespace prefix segment by
    /// segment until a prefix resolves to a referenced CLR type. On success the
    /// resolved type is returned as an <see cref="ImportedClassSymbol"/> and
    /// <paramref name="rightPart"/> is advanced to the remaining (post-type)
    /// member-access chain. Shared by <see cref="TryBindImportAccessor"/> (which
    /// starts from a registered import target) and
    /// <see cref="TryBindFullyQualifiedClrStaticAccess"/> (which starts from a
    /// bare leading namespace name).
    /// </summary>
    private bool TryWalkQualifiedClrTypePath(string startPath, ref ExpressionSyntax rightPart, out ImportedClassSymbol importedClass)
    {
        importedClass = null;

        var currentPath = startPath;
        var currentRight = rightPart;

        while (true)
        {
            // Issue #2209: `Ns.Sub.Generic[Args].StaticMember` places a generic
            // instantiation (`Comparer[int32]`, parsed as an `IndexExpressionSyntax`
            // for a single type argument or a `GenericNameExpressionSyntax` for
            // multiple/type-shaped arguments) in the middle of the dotted chain,
            // immediately followed by the static member access. Neither shape is
            // a plain `NameExpressionSyntax` segment, so without this case the
            // walk below falls through to `default: return false` at the FIRST
            // segment, and the caller re-reports the whole chain as an undefined
            // type starting from its leftmost name. Close the generic type here
            // (mirroring the non-generic branch just below) and hand the
            // remaining chain back as the static-member access on the closed type.
            if (currentRight is AccessorExpressionSyntax genericSegment
                && TryGetGenericSegmentNameAndArity(genericSegment.LeftPart, out var genericSegmentName, out var genericArity))
            {
                var mangledName = currentPath + "." + genericSegmentName + "`" + genericArity;
                if (scope.References.TryResolveType(mangledName, out var openGenericType)
                    && TryBindGenericImportSegmentTypeArguments(genericSegment.LeftPart, genericArity, out var segmentTypeArgs)
                    && TryCloseImportedGenericTypeReceiver(openGenericType, segmentTypeArgs, genericSegment.LeftPart, out var closedGenericImported))
                {
                    importedClass = closedGenericImported;
                    rightPart = genericSegment.RightPart;
                    return true;
                }

                // A generic instantiation can never be a further namespace
                // level, so a failed resolution here ends the walk instead of
                // falling through to the plain-segment cases below.
                return false;
            }

            NameExpressionSyntax typeNameSyntax;
            ExpressionSyntax remainder;
            bool hasMoreChain;

            switch (currentRight)
            {
                case AccessorExpressionSyntax nested when nested.LeftPart is NameExpressionSyntax leftName:
                    typeNameSyntax = leftName;
                    remainder = nested.RightPart;
                    hasMoreChain = true;
                    break;

                case NameExpressionSyntax ne:
                    typeNameSyntax = ne;
                    remainder = ne;
                    hasMoreChain = false;
                    break;

                default:
                    return false;
            }

            var fullTypeName = currentPath + "." + typeNameSyntax.IdentifierToken.Text;
            if (scope.References.TryResolveType(fullTypeName, out var type))
            {
                importedClass = new ImportedClassSymbol(type, typeNameSyntax, references: scope.References);
                rightPart = remainder;
                return true;
            }

            // Not a type. If there's still a chain to consume, treat this segment
            // as another namespace level and keep walking. Otherwise, give up.
            if (!hasMoreChain)
            {
                return false;
            }

            currentPath = fullTypeName;
            currentRight = remainder;
        }
    }

    /// <summary>
    /// Issue #2209: recognises a generic-instantiation segment
    /// (<c>Comparer[int32]</c>) in the middle of a fully-qualified dotted
    /// namespace/type chain and returns its simple type name and arity. The
    /// parser shapes a single type argument as an <see cref="IndexExpressionSyntax"/>
    /// (target is the bare type name, e.g. <c>Comparer[int32]</c>) and multiple
    /// or type-shaped arguments as a <see cref="GenericNameExpressionSyntax"/>
    /// (e.g. <c>Pair[int32, string]</c>, <c>Box[int32?]</c>).
    /// </summary>
    private static bool TryGetGenericSegmentNameAndArity(ExpressionSyntax segment, out string name, out int arity)
    {
        switch (segment)
        {
            case IndexExpressionSyntax index when !index.IsNullConditional && index.Target is NameExpressionSyntax indexName:
                name = indexName.IdentifierToken.Text;
                arity = 1;
                return true;

            case GenericNameExpressionSyntax generic:
                name = generic.Identifier.Text;
                arity = generic.TypeArgumentList.Arguments.Count;
                return true;

            default:
                name = null;
                arity = 0;
                return false;
        }
    }

    /// <summary>
    /// Issue #2209: binds the type-argument(s) of a generic-instantiation
    /// segment recognised by <see cref="TryGetGenericSegmentNameAndArity"/>,
    /// dispatching to the matching argument shape (index-expression argument or
    /// generic-name type-argument list).
    /// </summary>
    private bool TryBindGenericImportSegmentTypeArguments(ExpressionSyntax segment, int arity, out ImmutableArray<TypeSymbol> typeArgs)
    {
        switch (segment)
        {
            case IndexExpressionSyntax index:
                return TryBindTypeArgumentExpressions(index.Index, out typeArgs) && typeArgs.Length == arity;

            case GenericNameExpressionSyntax generic:
                return TryBindGenericSegmentArguments(generic, out typeArgs) && typeArgs.Length == arity;

            default:
                typeArgs = default;
                return false;
        }
    }

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

        // Issue #2394: check the same-compilation SOURCE type (struct/enum)
        // BEFORE the imported CLR class so it wins on a same-simple-name
        // collision — matching Binder.LookupType's precedence and the
        // read-path fix above in BindAccessorExpression.
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

        if (scope.TryLookupImportedClass(name, leftName, out var importedClass))
        {
            importedClassSymbol = importedClass;
            return true;
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
            return !TypeMemberModel.GetMethods(structSym, headName, MemberQuery.InheritedStatic(MemberKinds.Method)).IsEmpty
                || ClrTypeExposesStaticMember(TypeMemberModel.GetNearestImportedBase(structSym)?.ClrType, headName);
        }

        return TypeMemberModel.LookupMember(
            structSym,
            headName,
            MemberQuery.InheritedStatic(MemberKinds.Field | MemberKinds.Property)) != null
            || ClrTypeExposesStaticMember(TypeMemberModel.GetNearestImportedBase(structSym)?.ClrType, headName);
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
                // Issue #1537: the left portion may name a nested TYPE of the
                // constructed receiver (`Middle[string]` under `Outer[int32]`),
                // with the rightPart a composite literal / member / call on that
                // nested type — i.e. a per-segment generic chain of depth ≥ 3
                // (`Outer[int32].Middle[string].Inner{…}`) parses right-leaning
                // so the inner segments arrive here rather than at the top-level
                // accessor. Resolve the nested-type chain under the receiver
                // (threading the flattened enclosing arguments) and bind the
                // tail against it. Falls through to the value/static-member path
                // when the left portion is not a nested type.
                if (TryResolveNestedTypeChainUnderReceiver(structSym, nested.LeftPart, out var innerReceiver))
                {
                    return BindUserTypeStaticAccessorStep(innerReceiver, nested.RightPart);
                }

                if (TypeMemberModel.GetNearestImportedBase(structSym)?.ClrType is Type importedBase)
                {
                    var importedBaseSymbol = new ImportedClassSymbol(importedBase, nested.LeftPart, references: scope.References);
                    if (TryResolveNestedTypeFromAccessorLeft(importedBaseSymbol, nested.LeftPart, out var importedNested))
                    {
                        importedNested = CloseImportedNestedType(importedBase, importedNested, nested.LeftPart);
                        return BindAccessorStep(receiver: null, importedNested, nested.RightPart);
                    }
                }

                var head = BindUserTypeStaticAccessorStep(structSym, nested.LeftPart);
                if (head is BoundErrorExpression)
                {
                    return head;
                }

                if (nested.IsNullConditional)
                {
                    return BindNullConditionalAccessExpressionCore(head, nested.RightPart);
                }

                return BindAccessorStep(head, null, nested.RightPart);

            case CallExpressionSyntax ce:
                return BindUserTypeStaticCall(structSym, ce);

            // Issue #1537: a composite literal for a type nested inside a
            // CONSTRUCTED generic enclosing type
            // (`Outer[int32].Middle[string]{…}`, `Box[int32].Tag{…}`). The outer
            // segment (`Outer[int32]`) resolves to the constructed struct
            // receiver `structSym`; resolve the nested type under its definition
            // and bind the literal against it, threading the enclosing
            // construction's flattened arguments so member types substitute the
            // enclosing parameters and the emitter encodes the reified nested
            // type. Mirrors the #1069 peel-off path in BindAccessorExpression
            // that already handles a NON-generic enclosing segment.
            case StructLiteralExpressionSyntax structLiteral:
                return BindQualifiedNestedStructLiteral(structSym, structLiteral);

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
    /// Issue #1537: binds a composite literal naming a type nested inside a
    /// CONSTRUCTED generic enclosing type
    /// (<c>Outer[int32].Middle[string]{…}</c>, <c>Box[int32].Tag{…}</c>). The
    /// nested type is resolved under <paramref name="outerConstructed"/>'s
    /// definition, and the enclosing construction's flattened type arguments
    /// (its own enclosing arguments followed by its own arguments, outermost
    /// first — aligned with <see cref="StructSymbol.CollectEnclosingTypeParameters(TypeSymbol)"/>)
    /// are threaded onto the constructed nested symbol so member types
    /// substitute the enclosing parameters and the emitter encodes the reified
    /// nested type. Generalizes to arbitrary depth: at each level the outer
    /// segment already carries the flattened arguments of everything above it.
    /// </summary>
    /// <param name="outerConstructed">The constructed generic enclosing segment (e.g. <c>Outer[int32]</c>).</param>
    /// <param name="structLiteral">The nested composite literal (e.g. <c>Middle[string]{…}</c>).</param>
    /// <returns>The bound nested struct literal, or a bound error expression.</returns>
    private BoundExpression BindQualifiedNestedStructLiteral(StructSymbol outerConstructed, StructLiteralExpressionSyntax structLiteral)
    {
        var container = outerConstructed.Definition ?? outerConstructed;
        var literalArity = structLiteral.TypeArgumentList != null ? structLiteral.TypeArgumentList.Arguments.Count : -1;
        TypeSymbol nestedType;
        StructSymbol declaringContainer = outerConstructed;
        if (!scope.TryLookupNestedTypeAlias(container, structLiteral.TypeIdentifier.Text, literalArity, out nestedType)
            && !scope.TryLookupNestedTypeAliasIncludingInherited(
                outerConstructed,
                structLiteral.TypeIdentifier.Text,
                literalArity,
                out nestedType,
                out declaringContainer))
        {
            Diagnostics.ReportUnableToFindType(structLiteral.TypeIdentifier.Location, structLiteral.TypeIdentifier.Text);
            return new BoundErrorExpression(null);
        }

        if (nestedType is not StructSymbol nestedStructDef)
        {
            Diagnostics.ReportUnableToFindType(structLiteral.TypeIdentifier.Location, structLiteral.TypeIdentifier.Text);
            return new BoundErrorExpression(null);
        }

        // The enclosing construction already flattens its own enclosing chain in
        // EnclosingTypeArguments; append its own TypeArguments so the nested
        // type sees the full outermost-first vector.
        var enclosingArgs = FlattenConstructedEnclosingArguments(declaringContainer);
        return BindStructLiteralExpression(structLiteral, nestedStructDef.Definition ?? nestedStructDef, enclosingArgs);
    }

    /// <summary>
    /// Issue #1537: resolves a nested-type-naming expression evaluated UNDER a
    /// constructed generic receiver — e.g. <c>Middle[string]</c> (or the deeper
    /// <c>Middle[string].Deeper[y]</c>) under a receiver <c>Outer[int32]</c> —
    /// to the constructed nested type symbol, threading the receiver's flattened
    /// enclosing arguments plus each intervening segment's own arguments so the
    /// deepest segment carries the full outermost-first argument vector
    /// (<c>Outer`1+Middle`2&lt;int32, string&gt;</c>). Returns <see langword="false"/>
    /// (without diagnostics) when the expression does not name a nested type of
    /// the receiver, so the caller can fall back to the value/static-member path.
    /// </summary>
    /// <param name="receiver">The constructed generic receiver the chain is nested under.</param>
    /// <param name="typeExpr">The nested-type-naming expression.</param>
    /// <param name="constructed">The resolved constructed nested type on success.</param>
    /// <returns>Whether the expression named a nested type of the receiver.</returns>
    private bool TryResolveNestedTypeChainUnderReceiver(StructSymbol receiver, ExpressionSyntax typeExpr, out StructSymbol constructed)
    {
        constructed = null;
        var segments = new List<(string Name, ImmutableArray<TypeSymbol> Args)>();
        if (!TryFlattenUserTypeExpressionSegments(typeExpr, segments) || segments.Count == 0)
        {
            return false;
        }

        var enclosingArgs = FlattenConstructedEnclosingArguments(receiver);
        TypeSymbol containerDef = receiver.Definition ?? receiver;
        for (var i = 0; i < segments.Count; i++)
        {
            var arity = segments[i].Args.IsDefaultOrEmpty ? -1 : segments[i].Args.Length;
            var lookupContainer = (containerDef as StructSymbol)?.Definition ?? containerDef;
            TypeSymbol nested;
            if (!scope.TryLookupNestedTypeAlias(lookupContainer, segments[i].Name, arity, out nested))
            {
                if (containerDef is StructSymbol containerStruct
                    && scope.TryLookupNestedTypeAliasIncludingInherited(containerStruct, segments[i].Name, arity, out var inheritedNested, out var inheritedOwner))
                {
                    nested = inheritedNested;
                    enclosingArgs = FlattenConstructedEnclosingArguments(inheritedOwner);
                }
                else
                {
                    return false;
                }
            }

            if (i < segments.Count - 1)
            {
                // Enclosing segment: accumulate its own arguments (if generic)
                // onto the flattened vector threaded into the next level.
                if (!segments[i].Args.IsDefaultOrEmpty)
                {
                    enclosingArgs = enclosingArgs.IsDefaultOrEmpty
                        ? segments[i].Args
                        : enclosingArgs.AddRange(segments[i].Args);
                }

                containerDef = nested;
                continue;
            }

            if (nested is not StructSymbol nestedStruct)
            {
                return false;
            }

            var def = nestedStruct.Definition ?? nestedStruct;
            var ownArgs = segments[i].Args;
            if (!enclosingArgs.IsDefaultOrEmpty && !ownArgs.IsDefaultOrEmpty)
            {
                constructed = StructSymbol.ConstructNestedGeneric(def, enclosingArgs, ownArgs, scope.References.MapClrTypeToReferences);
            }
            else if (!enclosingArgs.IsDefaultOrEmpty)
            {
                constructed = StructSymbol.ConstructNested(def, enclosingArgs, scope.References.MapClrTypeToReferences);
            }
            else if (!ownArgs.IsDefaultOrEmpty)
            {
                constructed = StructSymbol.Construct(def, ownArgs, scope.References.MapClrTypeToReferences);
            }
            else
            {
                constructed = def;
            }

            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #1537: flattens the type arguments of a constructed generic
    /// enclosing segment into the outermost-first vector its nested types are
    /// reified over — the segment's own <see cref="StructSymbol.EnclosingTypeArguments"/>
    /// (from levels above it) followed by its own <see cref="StructSymbol.TypeArguments"/>.
    /// Returns <c>default</c> when the segment carries no type arguments (a
    /// non-generic enclosing type contributes nothing to thread).
    /// </summary>
    /// <param name="outerConstructed">The constructed (or open) enclosing segment.</param>
    /// <returns>The flattened enclosing-argument vector, or <c>default</c>.</returns>
    private static ImmutableArray<TypeSymbol> FlattenConstructedEnclosingArguments(StructSymbol outerConstructed)
    {
        var enclosing = outerConstructed.EnclosingTypeArguments;
        var own = outerConstructed.TypeArguments;
        if (enclosing.IsDefaultOrEmpty && own.IsDefaultOrEmpty)
        {
            return default;
        }

        var builder = ImmutableArray.CreateBuilder<TypeSymbol>();
        if (!enclosing.IsDefaultOrEmpty)
        {
            builder.AddRange(enclosing);
        }

        if (!own.IsDefaultOrEmpty)
        {
            builder.AddRange(own);
        }

        return builder.ToImmutable();
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
            // Issue #1433: `IName.method(args)` — a static (`shared`) method
            // declared on the interface. Route through the same canonical
            // member-resolution + overload machinery used for struct/class
            // statics; the only difference (a constructed generic interface
            // owner) is carried on the bound call for the emitter.
            case CallExpressionSyntax ce:
                return BindUserTypeStaticCall(interfaceSym, ce);

            case NameExpressionSyntax ne:
                return BindInterfaceStaticMemberAccess(interfaceSym, fieldOwner, ne);

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
    /// Issue #1433: resolves <c>IName.member</c> in non-call position against an
    /// interface's static members. A static field reads to a static
    /// <see cref="BoundFieldAccessExpression"/> (issue #1030); a static
    /// (<c>shared</c>) method named here is a method group with a null receiver
    /// (overload selection deferred to the conversion classifier), mirroring the
    /// struct/class path in <see cref="BindUserTypeStaticMemberAccess"/>.
    /// </summary>
    /// <param name="interfaceSym">The interface receiver (constructed or open).</param>
    /// <param name="fieldOwner">The interface definition owning static fields.</param>
    /// <param name="ne">The member being accessed.</param>
    /// <returns>The bound access, or a bound error expression.</returns>
    private BoundExpression BindInterfaceStaticMemberAccess(InterfaceSymbol interfaceSym, InterfaceSymbol fieldOwner, NameExpressionSyntax ne)
    {
        var memberName = ne.IdentifierToken.Text;

        var field = fieldOwner.GetStaticField(memberName);
        if (field != null)
        {
            return new BoundFieldAccessExpression(null, field, interfaceSym);
        }

        // Issue #1433: a default-bodied static (`shared`) property on the
        // interface (ADR-0089 / issue #1019) read in non-call position. Static
        // interface properties are modeled as static-virtual accessor methods,
        // not on a `StaticProperties` bucket, so a direct read is lowered to a
        // call of the getter MethodDef — reusing the static-method-call emit
        // path. Only a concrete (non-abstract, default-bodied) getter can be
        // invoked directly on the interface type.
        foreach (var prop in fieldOwner.Properties)
        {
            if (prop.IsStatic && !prop.IsIndexer && prop.Name == memberName)
            {
                if (prop.GetterSymbol != null && prop.HasGetter)
                {
                    return new BoundCallExpression(null, prop.GetterSymbol, ImmutableArray<BoundExpression>.Empty, prop.Type)
                    {
                        StaticGenericInterfaceOwnerType = interfaceSym.Definition != null ? interfaceSym : null,
                    };
                }

                Diagnostics.ReportUnableToFindMember(ne.Location, memberName);
                return new BoundErrorExpression(null);
            }
        }

        // ADR-0112: a static method named here in non-call position is a method
        // group with a null receiver, driven by the target delegate signature.
        var staticMethods = TypeMemberModel.GetMethods(interfaceSym, memberName, MemberQuery.Static(MemberKinds.Method));
        if (TryBuildUserMethodGroup(receiver: null, staticMethods, out var staticGroup))
        {
            return staticGroup;
        }

        Diagnostics.ReportUnableToFindMember(ne.Location, memberName);
        return new BoundErrorExpression(null);
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

        constructed = InterfaceSymbol.Construct(ifaceDef, typeArgs, scope.References.MapClrTypeToReferences);
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

        // Issue #1395: when a non-generic (arity-0) type and a generic type
        // share the same simple name (arity overloading, e.g. `Box` and
        // `Box[T]`), the arity-unaware lookup prefers the arity-0 type and the
        // generic receiver fails to resolve. Disambiguate using the bracketed
        // type-argument count so `Box[int32]` selects the arity-1 `Box[T]`.
        var userGenericDef = scope.TryLookupTypeAlias(name, preferredArity: arity, out var alias)
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
                    constructedStruct = StructSymbol.Construct(structDef, typeArgs, scope.References.MapClrTypeToReferences);
                    return true;
                case InterfaceSymbol ifaceDef:
                    constructedInterface = InterfaceSymbol.Construct(ifaceDef, typeArgs, scope.References.MapClrTypeToReferences);
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

        // Issue #1395: same arity-collision disambiguation as the
        // index-expression overload — select the same-name type whose generic
        // arity matches the supplied type-argument count so `Box[int32]`
        // resolves to `Box[T]` rather than the non-generic `Box`.
        var userGenericDef = scope.TryLookupTypeAlias(name, preferredArity: arity, out var alias)
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
                    constructedStruct = StructSymbol.Construct(structDef, typeArgs, scope.References.MapClrTypeToReferences);
                    return true;
                case InterfaceSymbol ifaceDef:
                    constructedInterface = InterfaceSymbol.Construct(ifaceDef, typeArgs, scope.References.MapClrTypeToReferences);
                    return true;
            }
        }

        return TryCloseImportedGenericTypeReceiver(openClrType, typeArgs, generic, out constructedImported);
    }

    /// <summary>
    /// Issue #1559: syntax-shape-agnostic dispatcher over the two
    /// constructed-generic-type receiver resolvers. A qualified generic-type
    /// receiver <c>G[T1..Tn]</c> reaches the binder as either an
    /// <see cref="IndexExpressionSyntax"/> (single type argument that also reads
    /// as an index — <c>Foo[T]</c>, <c>Box[int32]</c>) or a
    /// <see cref="GenericNameExpressionSyntax"/> (arguments the parser could only
    /// shape as types — <c>Box[int32?]</c>, <c>Pair[int32, string]</c>,
    /// <c>Box[List[int32]]</c>). Both read (member access) and write (assignment
    /// target) receiver resolution route through here so the WRITE path mirrors
    /// the READ path (<see cref="BindAccessorExpression"/>) exactly rather than
    /// duplicating shape-specific logic.
    /// </summary>
    /// <param name="receiver">The candidate constructed-generic-type receiver syntax.</param>
    /// <param name="constructedStruct">The constructed generic class/struct on success.</param>
    /// <param name="constructedInterface">The constructed generic interface on success.</param>
    /// <param name="constructedImported">The constructed imported CLR generic type on success.</param>
    /// <returns>Whether a constructed generic type receiver was resolved.</returns>
    private bool TryResolveConstructedGenericTypeReceiver(
        ExpressionSyntax receiver,
        out StructSymbol constructedStruct,
        out InterfaceSymbol constructedInterface,
        out ImportedClassSymbol constructedImported)
    {
        constructedStruct = null;
        constructedInterface = null;
        constructedImported = null;

        switch (receiver)
        {
            case IndexExpressionSyntax index when !index.IsNullConditional:
                return TryResolveConstructedGenericTypeReceiver(index, out constructedStruct, out constructedInterface, out constructedImported);
            case GenericNameExpressionSyntax generic:
                return TryResolveConstructedGenericTypeReceiver(generic, out constructedStruct, out constructedInterface, out constructedImported);
            case AccessorExpressionSyntax accessorChain when !accessorChain.IsNullConditional:
                // A package-qualified generic type receiver written by cs2gs,
                // e.g. `Oahu.Aux.Diagnostics.TreeDecomposition[T].field = v`. The
                // leading namespace segments are redundant for a source type; peel
                // them and re-dispatch on the bare constructed-generic terminal.
                var peeled = PeelNamespacePrefix(accessorChain);
                if (!ReferenceEquals(peeled, accessorChain)
                    && peeled is IndexExpressionSyntax or GenericNameExpressionSyntax)
                {
                    return TryResolveConstructedGenericTypeReceiver(peeled, out constructedStruct, out constructedInterface, out constructedImported);
                }

                return false;
            default:
                return false;
        }
    }

    /// <summary>
    /// Whether <paramref name="segment"/> is a pure namespace/package prefix
    /// component — it does not name a known type/alias, an import alias, or an
    /// imported class, and (only for the leading segment of a chain, per
    /// <paramref name="isLeadingSegment"/>) does not name an in-scope value.
    /// cs2gs fully-qualifies type references, so a leading run of such segments
    /// in front of a same-compilation source type is redundant and must be
    /// peeled before binding by simple name.
    /// <para>
    /// The in-scope-value check is restricted to the leading segment because it
    /// is what distinguishes a genuine value-access chain (e.g.
    /// <c>myOahu.Foo.Ctor()</c>, where <c>myOahu</c> really is a value) from a
    /// namespace-qualified construction. Once a segment has already been
    /// accepted as a namespace-prefix component (i.e. peeling is past the first
    /// segment), the chain can no longer be reinterpreted as a value-access
    /// chain — there is no value at its head to access <c>.member</c> on — so a
    /// later segment coincidentally sharing a name with an unrelated in-scope
    /// value (e.g. a field or const declared on the enclosing type, see issue
    /// #2419) is not a genuine alternate interpretation and must not stop
    /// peeling.
    /// </para>
    /// </summary>
    /// <param name="segment">The dotted-name segment to classify.</param>
    /// <param name="isLeadingSegment">
    /// Whether <paramref name="segment"/> is the first segment being peeled from
    /// the chain (as opposed to a later, already-committed continuation).
    /// </param>
    /// <returns>Whether the segment is a pure namespace/package prefix.</returns>
    private bool IsNamespacePrefixSegment(string segment, bool isLeadingSegment = true) =>
        (!isLeadingSegment || scope.TryLookupSymbol(segment) is not VariableSymbol)
        && !scope.TryLookupTypeAlias(segment, out _)
        && !(scope.TryLookupImport(segment, out var import) && import.IsAlias)
        && !scope.TryLookupImportedClass(segment, declaration: null, out _);

    /// <summary>
    /// Peels a leading run of pure namespace/package segments off a dotted
    /// accessor chain, returning the first non-namespace remainder (unchanged
    /// when the head is not a namespace segment). Used to strip a redundant
    /// package prefix cs2gs emits in front of a same-compilation source type.
    /// </summary>
    /// <param name="expr">The dotted accessor chain to peel.</param>
    /// <returns>The first non-namespace remainder of the chain.</returns>
    private ExpressionSyntax PeelNamespacePrefix(ExpressionSyntax expr)
    {
        var current = expr;
        var peeledAny = false;
        while (current is AccessorExpressionSyntax accessor
               && !accessor.IsNullConditional
               && accessor.LeftPart is NameExpressionSyntax leftName
               && IsNamespacePrefixSegment(leftName.IdentifierToken.Text, isLeadingSegment: !peeledAny))
        {
            current = accessor.RightPart;
            peeledAny = true;
        }

        return current;
    }

    /// <summary>
    /// Closes an open imported CLR generic definition over the CLR types of the
    /// bound type arguments (e.g. <c>ArrayPool`1</c> + <c>byte</c> -&gt;
    /// <c>ArrayPool&lt;byte&gt;</c>) and surfaces it as an
    /// <see cref="ImportedClassSymbol"/> so the existing static-member /
    /// static-call binding path resolves members against the closed
    /// construction. Shared by the index-expression and generic-name receiver
    /// resolvers (Issue #1209 / Issue #1323).
    /// </summary>
    private bool TryCloseImportedGenericTypeReceiver(
        Type openClrType,
        ImmutableArray<TypeSymbol> typeArgs,
        ExpressionSyntax receiverSyntax,
        out ImportedClassSymbol constructedImported)
    {
        constructedImported = null;

        var clrArgs = new Type[typeArgs.Length];
        for (var i = 0; i < typeArgs.Length; i++)
        {
            // Issue #1330 (#313 / #671): an in-scope generic type-parameter
            // argument (`Comparer[TResult].Create(...)`, `Comparer[U].Default`)
            // — or any other symbolic type that has no CLR type yet (a
            // not-yet-emitted user type) — has no concrete System.Type to close
            // the imported generic over. Mirror ConstructIfGeneric's type-erased
            // generic model and project such an argument onto System.Object for
            // the closed CLR shape, so the constructed-generic *type* receiver is
            // well formed and static-member access / static calls resolve. This
            // keeps the type-parameter receiver consistent with how the same
            // `Comparer[TResult]` shape binds in type-clause position.
            var clr = TypeSymbol.ContainsTypeParameter(typeArgs[i])
                ? typeof(object)
                : NullableTypeSymbol.GetEffectiveClrType(typeArgs[i]);
            clr ??= typeof(object);

            // Project the host CLR type argument onto the resolver's reference
            // set so it shares the open type's load context (its
            // MetadataLoadContext when references are supplied via /reference:),
            // which MakeGenericType requires (mirrors Binder.BindGenericClrType).
            clrArgs[i] = scope.References.MapClrTypeToReferences(clr);
        }

        try
        {
            var closed = openClrType.MakeGenericType(clrArgs);

            // Issue #1330: when any type argument is symbolic (an in-scope
            // generic type parameter, or a user type with no CLR type yet), the
            // closed CLR shape above is type-erased to `object`. Carry the
            // symbolic constructed view alongside it so static-member access and
            // static calls recover symbolic member/return types
            // (`Comparer[TResult].Default : Comparer[TResult]`) and the emitter
            // parents the static member reference at the constructed
            // `Comparer<!TResult>` TypeSpec instead of the erased
            // `Comparer<object>` — yielding verifiable IL exactly as the
            // concrete-argument receiver does.
            var symbolicReceiver = typeArgs.Any(static a => TypeSymbol.ContainsTypeParameter(a) || a.ClrType == null)
                ? ImportedTypeSymbol.GetConstructed(closed, openClrType, typeArgs)
                : null;
            constructedImported = new ImportedClassSymbol(closed, receiverSyntax, symbolicReceiver, scope.References);
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
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

    /// <summary>
    /// Issue #1201 (C# <c>using static</c>): attempts to resolve an unqualified
    /// identifier against the <c>shared</c> (static) members — field, property,
    /// or method group — of a type brought into scope by a non-alias type import
    /// (<c>import Ns.Type</c>). Binds against the single match through the same
    /// <see cref="BindUserTypeStaticMemberAccess"/> path used by an explicit
    /// <c>Type.Member</c> access; reports GS0414 when two or more imported types
    /// expose a member of that name (the value/identifier analog of the
    /// call-site ambiguity rule in <c>OverloadResolver</c>).
    /// </summary>
    /// <param name="syntax">The bare-name reference being resolved.</param>
    /// <param name="result">The bound static-member access, when one is produced.</param>
    /// <returns><c>true</c> when an imported static member matched (or an ambiguity was reported).</returns>
    private bool TryBindImportedStaticMember(NameExpressionSyntax syntax, out BoundExpression result)
    {
        result = null;
        var name = syntax.IdentifierToken.Text;

        StructSymbol match = null;
        var ambiguous = false;
        foreach (var importedType in binderCtx.GetStaticImportTypes())
        {
            if (!ImportedTypeExposesStaticMember(importedType, name))
            {
                continue;
            }

            if (match == null)
            {
                match = importedType;
            }
            else if (!ReferenceEquals(match, importedType))
            {
                ambiguous = true;
                break;
            }
        }

        if (ambiguous)
        {
            Diagnostics.ReportAmbiguousImportedStaticMember(syntax.IdentifierToken.Location, name);
            result = new BoundErrorExpression(null);
            return true;
        }

        if (match != null)
        {
            result = BindUserTypeStaticMemberAccess(match, syntax);
            return true;
        }

        // ADR-0134 (extended): fall back to referenced-assembly CLR types brought
        // into scope by a type import (`import System.Math` from C#'s
        // `using static System.Math`). Only consulted when no same-compilation
        // source class exposed the member above.
        System.Type clrMatch = null;
        var clrAmbiguous = false;
        foreach (var clrType in scope.EnumerateStaticImportClrTypes())
        {
            if (!ClrTypeExposesStaticMember(clrType, name))
            {
                continue;
            }

            if (clrMatch == null)
            {
                clrMatch = clrType;
            }
            else if (!ClrTypeUtilities.IsSameAs(clrMatch, clrType))
            {
                clrAmbiguous = true;
                break;
            }
        }

        if (clrAmbiguous)
        {
            Diagnostics.ReportAmbiguousImportedStaticMember(syntax.IdentifierToken.Location, name);
            result = new BoundErrorExpression(null);
            return true;
        }

        if (clrMatch != null)
        {
            var classSymbol = new ImportedClassSymbol(clrMatch, syntax, references: scope.References);
            result = BindAccessorStep(receiver: null, classSymbol, syntax);
            return true;
        }

        return false;
    }

    /// <summary>
    /// Whether the referenced-assembly CLR <paramref name="type"/> declares a
    /// <c>public static</c> field, property, or method named <paramref name="name"/>
    /// — the imported-CLR analogue of <see cref="ImportedTypeExposesStaticMember"/>.
    /// </summary>
    private static bool ClrTypeExposesStaticMember(System.Type type, string name)
    {
        if (type == null)
        {
            return false;
        }

        const System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public;
        foreach (var m in ClrTypeUtilities.SafeGetMethods(type, flags))
        {
            if (string.Equals(m.Name, name, System.StringComparison.Ordinal))
            {
                return true;
            }
        }

        foreach (var p in ClrTypeUtilities.SafeGetProperties(type, flags))
        {
            if (string.Equals(p.Name, name, System.StringComparison.Ordinal))
            {
                return true;
            }
        }

        foreach (var f in ClrTypeUtilities.SafeGetFields(type, flags))
        {
            if (string.Equals(f.Name, name, System.StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #1201: whether <paramref name="structSym"/> declares a <c>shared</c>
    /// (static) field, property, or method named <paramref name="name"/> —
    /// i.e. a member a type import would expose for unqualified reference.
    /// </summary>
    /// <param name="structSym">The imported type.</param>
    /// <param name="name">The member name.</param>
    /// <returns><c>true</c> when a matching static member exists.</returns>
    private static bool ImportedTypeExposesStaticMember(StructSymbol structSym, string name)
        => TypeMemberModel.TryGetStaticFieldIncludingInherited(structSym, name, out _, out _)
            || TypeMemberModel.TryGetStaticPropertyIncludingInherited(structSym, name, out _, out _)
            || !TypeMemberModel.GetMethods(structSym, name, MemberQuery.InheritedStatic(MemberKinds.Method)).IsDefaultOrEmpty;

    private BoundExpression BindUserTypeStaticMemberAccess(StructSymbol structSym, NameExpressionSyntax ne)
    {
        var memberName = ne.IdentifierToken.Text;

        // ADR-0112: static field/property lookups go through the canonical layer.
        if (TypeMemberModel.TryGetStaticFieldIncludingInherited(structSym, memberName, out var field, out var fieldOwner))
        {
            if (!AccessibilityChecker.IsAccessible(field.Accessibility, fieldOwner, function))
            {
                Diagnostics.ReportMemberInaccessible(ne.Location, field.Name, fieldOwner.Name, field.Accessibility);
            }

            var fieldType = fieldOwner.SubstituteMemberType(field.Type);
            return new BoundFieldAccessExpression(null, receiver: null, fieldOwner, field, fieldType);
        }

        if (TypeMemberModel.TryGetStaticPropertyIncludingInherited(structSym, memberName, out var prop, out var propertyOwner))
        {
            if (!AccessibilityChecker.IsAccessible(prop.Accessibility, propertyOwner, function))
            {
                Diagnostics.ReportMemberInaccessible(ne.Location, prop.Name, propertyOwner.Name, prop.Accessibility);
            }

            return new BoundPropertyAccessExpression(null, receiver: null, propertyOwner, prop);
        }

        // ADR-0112: a static (shared) method named here in non-call position is a
        // method group with a null receiver. Overload selection (when more than
        // one shared overload shares the name) is deferred to the conversion
        // classifier, driven by the target delegate signature.
        var staticMethods = TypeMemberModel.GetMethods(structSym, memberName, MemberQuery.InheritedStatic(MemberKinds.Method));
        if (TryBuildUserMethodGroup(receiver: null, staticMethods, out var staticGroup, staticOwnerType: structSym))
        {
            return staticGroup;
        }

        if (TypeMemberModel.GetNearestImportedBase(structSym)?.ClrType is System.Type importedBase)
        {
            var imported = new ImportedClassSymbol(importedBase, ne, references: scope.References);
            return BindAccessorStep(receiver: null, imported, ne);
        }

        Diagnostics.ReportUnableToFindMember(ne.Location, memberName);
        return new BoundErrorExpression(null);
    }

    internal BoundExpression BindUserTypeStaticCall(StructSymbol structSym, CallExpressionSyntax ce)
        => BindUserTypeStaticCall((TypeSymbol)structSym, ce);

    /// <summary>
    /// Issue #1433: resolves <c>TypeName.method(args)</c> for a static
    /// (<c>shared</c>) method declared on a user struct/class OR interface. The
    /// member-resolution and overload/substitution logic is identical for both
    /// owner kinds (it routes through the canonical <see cref="TypeMemberModel"/>
    /// layer, ADR-0112); only the generic-owner carried to the emitter differs:
    /// a constructed generic struct goes through
    /// <see cref="BoundCallExpression.StaticGenericOwnerType"/> (issue #1209) and
    /// a constructed generic interface through
    /// <see cref="BoundCallExpression.StaticGenericInterfaceOwnerType"/> (issue
    /// #1030 parenting extended to methods) so the call is parented at the
    /// correct construction <c>TypeSpec</c>. A non-generic owner of either kind
    /// emits a bare <c>MethodDef</c> token.
    /// </summary>
    internal BoundExpression BindUserTypeStaticCall(TypeSymbol ownerType, CallExpressionSyntax ce)
    {
        var structSym = ownerType as StructSymbol;
        var ifaceSym = ownerType as InterfaceSymbol;

        var methodName = ce.Identifier.Text;

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();
        List<int> deferredStaticLambdaIndices = null;
        var staticArgIndex = 0;
        foreach (var argument in ce.Arguments)
        {
            if (argument is RefArgumentExpressionSyntax refArg)
            {
                boundArguments.Add(BindRefArgumentExpression(refArg, parameter: null));
            }
            else if (IsUntypedArrowLambda(OverloadResolver.UnwrapNamedArgumentValue(argument)))
            {
                // Issue #951: defer un-typed arrow lambdas until the static
                // method overload (and its delegate-typed parameters) is known.
                (deferredStaticLambdaIndices ??= new List<int>()).Add(staticArgIndex);
                boundArguments.Add(new BoundErrorExpression(OverloadResolver.UnwrapNamedArgumentValue(argument)));
            }
            else
            {
                boundArguments.Add(BindExpression(argument));
            }

            staticArgIndex++;
        }

        var arguments = boundArguments.ToImmutable();

        // Issue #940: resolve static (shared) method overloads against the FULL
        // method group by arity, parameter types, and ref-kinds — identical to
        // the instance-method path — instead of taking the first by-name match
        // and arity-checking it (which rejected every overload but the first,
        // surfacing GS0144). The group is obtained through the ADR-0112
        // canonical member-resolution layer; OverloadResolver selects the best
        // candidate (and reports ambiguity / no-applicable-overload exactly as
        // for instance methods). A single-candidate group is returned unchanged
        // so the legacy per-position arity/optional/variadic diagnostics below
        // still apply (e.g. genuine arity mismatch on a non-overloaded method).
        var staticMethodGroup = TypeMemberModel.GetMethods(
            ownerType,
            methodName,
            structSym != null ? MemberQuery.InheritedStatic(MemberKinds.Method) : MemberQuery.Static(MemberKinds.Method));
        if (!staticMethodGroup.IsDefaultOrEmpty)
        {
            var selectionGroup = BuildConstructedStaticOverloadGroup(structSym, staticMethodGroup, out var originalMethods);
            var method = overloads.SelectInstanceOverloadOrReport(selectionGroup, arguments, ce, methodName, argumentNames: default);
            if (method == null)
            {
                return new BoundErrorExpression(null);
            }

            if (originalMethods != null && originalMethods.TryGetValue(method, out var originalMethod))
            {
                method = originalMethod;
            }

            var effectiveOwnerType = structSym != null && method.StaticOwnerType is StructSymbol declaredOwner
                ? TypeMemberModel.ResolveStaticMemberOwner(structSym, declaredOwner)
                : ownerType;
            var effectiveStructOwner = effectiveOwnerType as StructSymbol;
            var effectiveInterfaceOwner = effectiveOwnerType as InterfaceSymbol;
            var ownerDefinition = effectiveStructOwner?.Definition ?? (TypeSymbol)effectiveInterfaceOwner?.Definition;
            var ownerDefTypeParameters = effectiveStructOwner?.Definition?.TypeParameters
                ?? effectiveInterfaceOwner?.Definition?.TypeParameters
                ?? ImmutableArray<TypeParameterSymbol>.Empty;
            var ownerTypeArguments = effectiveStructOwner?.TypeArguments
                ?? effectiveInterfaceOwner?.TypeArguments
                ?? ImmutableArray<TypeSymbol>.Empty;

            // Issue #2071: enforce `protected`/`private` accessibility on static
            // (`shared`) method calls, mirroring the instance-call check in
            // OverloadResolver.BindUserInstanceCall (#950/#2044/#2058). Static
            // methods carry their declaring type via StaticOwnerType (they have
            // no receiver), unlike instance methods which use ReceiverType.
            if (method.StaticOwnerType is StructSymbol methodDeclaringType
                && !AccessibilityChecker.IsAccessible(method.Accessibility, methodDeclaringType, function))
            {
                Diagnostics.ReportMemberInaccessible(ce.Identifier.Location, method.Name, methodDeclaringType.Name, method.Accessibility);
            }

            // Issue #951: bind any deferred un-typed arrow lambda against the
            // selected static method's delegate-typed parameter so its omitted
            // parameter type(s) and inferred return type are filled in from the
            // parameter shape. Static (`shared`) methods carry no receiver
            // parameter, so the argument index maps directly to the parameter
            // index. A non-delegate parameter leaves the lambda deferred; it is
            // then bound with no target (surfacing GS0304).
            if (deferredStaticLambdaIndices != null)
            {
                var rebound = arguments.ToBuilder();
                foreach (var idx in deferredStaticLambdaIndices)
                {
                    if (rebound[idx] is not BoundErrorExpression { Syntax: LambdaExpressionSyntax staticLambda })
                    {
                        continue;
                    }

                    if (idx < method.Parameters.Length
                        && MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(method.Parameters[idx].Type, out var staticTarget)
                        && staticTarget != null)
                    {
                        rebound[idx] = lambdas.BindLambdaExpression(staticLambda, staticTarget);
                    }
                    else
                    {
                        rebound[idx] = lambdas.BindLambdaExpression(staticLambda);
                    }
                }

                arguments = rebound.ToImmutable();
            }

            // ADR-0101 follow-up / issue #812: a user-declared static method
            // may declare a trailing variadic parameter. Allow flexible
            // arity, infer the element type from trailing args (if generic),
            // and pack / pass-through trailing args into a single slice
            // argument before the per-position conversion loop.
            var isVariadic = method.Parameters.Length > 0 && method.Parameters[method.Parameters.Length - 1].IsVariadic;
            var fixedParamCount = isVariadic ? method.Parameters.Length - 1 : method.Parameters.Length;

            // ADR-0063 / issue #936: count the leading non-optional parameters.
            // A static (`shared`) call may omit any trailing parameter that
            // declares a default value, mirroring the instance-call path in
            // OverloadResolver. Omitted slots are synthesized below from each
            // parameter's captured default constant.
            var requiredParamCount = method.Parameters.Length;
            for (var i = method.Parameters.Length - 1; i >= 0; i--)
            {
                if (method.Parameters[i].HasExplicitDefaultValue)
                {
                    requiredParamCount = i;
                }
                else
                {
                    break;
                }
            }

            if (isVariadic)
            {
                if (arguments.Length < fixedParamCount)
                {
                    Diagnostics.ReportTooFewArgumentsForVariadic(ce.Location, method.Name, fixedParamCount, arguments.Length);
                    return new BoundErrorExpression(null);
                }
            }
            else if (arguments.Length < requiredParamCount || arguments.Length > method.Parameters.Length)
            {
                Diagnostics.ReportWrongArgumentCount(ce.Location, method.Name, method.Parameters.Length, arguments.Length);
                return new BoundErrorExpression(null);
            }

            // Issue #1379: a `shared` (static) method on a generic user type may
            // reference the type's own type parameter(s) in its return type
            // and/or parameter types (`func Make(v T) Box[T]`). When the receiver
            // is a closed construction (`Box[int32]`), seed the substitution map
            // with the struct's type parameters -> the construction's type
            // arguments so the call's return (and parameter) types are surfaced
            // closed (`Box[int32]`), not the raw/open form (which fails the
            // conversion to the closed type, GS0155). This is the user-defined
            // counterpart of the imported-generic fix in issue #1216 and exercises
            // the binding receiver added in issue #1323.
            Dictionary<TypeParameterSymbol, TypeSymbol> substitution = null;
            if (ownerDefinition != null
                && !ReferenceEquals(ownerDefinition, ownerType)
                && !ownerTypeArguments.IsDefaultOrEmpty
                && !ownerDefTypeParameters.IsDefaultOrEmpty)
            {
                substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
                var defParams = ownerDefTypeParameters;
                var count = Math.Min(defParams.Length, ownerTypeArguments.Length);
                for (var i = 0; i < count; i++)
                {
                    substitution[defParams[i]] = ownerTypeArguments[i];
                }
            }

            // Issue #312 / ADR-0020: resolve a generic static method's own type
            // arguments from an explicit `[T1, T2]` list at the call site or by
            // left-to-right inference from argument types.
            if (method.IsGeneric)
            {
                substitution ??= new Dictionary<TypeParameterSymbol, TypeSymbol>();
                if (ce.TypeArgumentList != null)
                {
                    var explicitArgs = ce.TypeArgumentList.Arguments;
                    if (explicitArgs.Count != method.TypeParameters.Length)
                    {
                        Diagnostics.ReportWrongTypeArgumentCount(ce.TypeArgumentList.Location, method.Name, method.TypeParameters.Length, explicitArgs.Count);
                        return new BoundErrorExpression(null);
                    }

                    for (var i = 0; i < explicitArgs.Count; i++)
                    {
                        var ta = bindTypeClause(explicitArgs[i]);
                        if (ta == null)
                        {
                            return new BoundErrorExpression(null);
                        }

                        substitution[method.TypeParameters[i]] = ta;
                    }
                }
                else
                {
                    // ADR-0101 follow-up / issue #812: when the static method is
                    // variadic, fixed parameters infer pairwise as before;
                    // for the variadic slot, infer the element type from each
                    // trailing argument. A single trailing `[]U` arg with
                    // pass-through inference still infers `T=U`.
                    var inferenceLimit = isVariadic ? fixedParamCount : arguments.Length;
                    for (var i = 0; i < inferenceLimit; i++)
                    {
                        Binder.InferTypeArguments(method.Parameters[i].Type, arguments[i].Type, substitution);
                    }

                    if (isVariadic)
                    {
                        var variadicParam = method.Parameters[method.Parameters.Length - 1];
                        var variadicElementType = ((SliceTypeSymbol)variadicParam.Type).ElementType;
                        var trailingCount = arguments.Length - fixedParamCount;
                        if (trailingCount == 1 && arguments[fixedParamCount].Type is SliceTypeSymbol singleSlice)
                        {
                            Binder.InferTypeArguments(variadicElementType, singleSlice.ElementType, substitution);
                        }
                        else
                        {
                            for (var i = fixedParamCount; i < arguments.Length; i++)
                            {
                                Binder.InferTypeArguments(variadicElementType, arguments[i].Type, substitution);
                            }
                        }
                    }

                    foreach (var tp in method.TypeParameters)
                    {
                        if (!substitution.ContainsKey(tp))
                        {
                            Diagnostics.ReportTypeArgumentInferenceFailed(ce.Identifier.Location, method.Name, tp.Name);
                            return new BoundErrorExpression(null);
                        }
                    }
                }

                var constraintLocation = ce.TypeArgumentList != null
                    ? ce.TypeArgumentList.Location
                    : ce.Identifier.Location;
                foreach (var tp in method.TypeParameters)
                {
                    var typeArg = substitution[tp];
                    if (!Binder.SatisfiesConstraint(typeArg, tp))
                    {
                        Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, Binder.DescribeConstraint(tp));
                        return new BoundErrorExpression(null);
                    }
                }
            }

            // ADR-0101 follow-up / issue #812: pack / pass-through for the
            // variadic slot. A single trailing arg whose type already equals
            // the substituted slice type passes through; otherwise wrap the
            // trailing args in a fresh `[]T` slice. Empty trailing => empty
            // slice.
            ImmutableArray<BoundExpression> permutedArgs;
            if (isVariadic)
            {
                var variadicParam = method.Parameters[method.Parameters.Length - 1];
                var sliceType = (SliceTypeSymbol)variadicParam.Type;
                var substitutedSlice = substitution != null
                    ? (SliceTypeSymbol)Binder.SubstituteType(sliceType, substitution, scope.References.MapClrTypeToReferences)
                    : sliceType;
                var hasVariadicErrors = false;

                // Issue #1823: route through the #1630 canonical helper so
                // trailing elements get the same per-element coercion applied
                // at every other variadic pack site (previously packed raw,
                // uncoerced elements here). Coerce against the SUBSTITUTED
                // slice's element type since generic type arguments may have
                // been inferred/substituted above.
                permutedArgs = OverloadResolver.PackOrPassThroughVariadicArguments(
                    conversions,
                    Diagnostics,
                    ce,
                    arguments,
                    fixedParamCount,
                    substitutedSlice,
                    variadicParam.Name,
                    i => i < ce.Arguments.Count ? ce.Arguments[i].Location : ce.Identifier.Location,
                    ref hasVariadicErrors);

                if (hasVariadicErrors)
                {
                    return new BoundErrorExpression(null);
                }
            }
            else
            {
                // ADR-0063 / issue #936: pad any trailing optional parameters
                // the static call omitted with their captured default values so
                // the per-position conversion loop binds the full parameter
                // list (matching instance-method behavior).
                if (arguments.Length < method.Parameters.Length)
                {
                    var padded = ImmutableArray.CreateBuilder<BoundExpression>(method.Parameters.Length);
                    padded.AddRange(arguments);
                    for (var i = arguments.Length; i < method.Parameters.Length; i++)
                    {
                        padded.Add(OverloadResolver.CreateOptionalUserDefaultArgument(method.Parameters[i]));
                    }

                    permutedArgs = padded.MoveToImmutable();
                }
                else
                {
                    permutedArgs = arguments;
                }
            }

            var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(permutedArgs.Length);
            for (var i = 0; i < permutedArgs.Length; i++)
            {
                var paramType = method.Parameters[i].Type;

                // ADR-0060 / issue #1139: an inline-decl `out var n` / `out let
                // n` / `out _` was bound with TypeSymbol.Error in the first
                // pass (before the static method was resolved) and never
                // declared a local. Now that overload resolution has chosen the
                // method — and the method type-argument substitution is known —
                // re-bind it (via the shared helper used by the instance path)
                // so the synthesized local is typed from the resolved
                // (substituted) out-parameter pointee type and leaks into the
                // enclosing block scope. The out-var arg always sits in the
                // fixed-parameter region, so permutedArgs[i] / ce.Arguments[i] /
                // method.Parameters[i] line up. This must run BEFORE the
                // open-type-parameter shortcut so generic static out-parameters
                // (`func G[T](out r T)`) are handled too.
                var slotSyntax = i < ce.Arguments.Count ? ce.Arguments[i] : null;
                var substitutedPointeeType = substitution != null ? Binder.SubstituteType(paramType, substitution, scope.References.MapClrTypeToReferences) : paramType;
                var reboundOutVar = TryRebindInlineOutVarPlaceholder(permutedArgs[i], slotSyntax, method.Parameters[i], substitutedPointeeType);
                if (reboundOutVar != null)
                {
                    convertedArgs.Add(reboundOutVar);
                    continue;
                }

                // Issue #1379: a parameter typed by the GENERIC STRUCT's own type
                // parameter (`func Make(v T)` on `Box[T]`) is substituted to the
                // closed receiver type argument (`int32`) so the argument is
                // converted to the concrete type. A parameter typed by an
                // unsubstituted (method) type parameter still passes through.
                if (paramType is TypeParameterSymbol typeParamParam
                    && (substitution == null || !substitution.ContainsKey(typeParamParam)))
                {
                    convertedArgs.Add(permutedArgs[i]);
                    continue;
                }

                if (substitution != null
                    && paramType is FunctionTypeSymbol openFunctionParameter
                    && LambdaBinder.TryGetFunctionLiteral(permutedArgs[i], out var functionLiteralArgument))
                {
                    // ADR-0087 §3 R6: substitute the open target before
                    // routing through the adapter. When the substituted
                    // target matches the literal's declared shape the
                    // adapter returns the literal unchanged (see
                    // IsIdentityAdapter), so the emitted MethodDef carries
                    // the literal's concrete signature and the reified
                    // Func/Action TypeSpec at the call site dispatches
                    // through real Invoke without DynamicInvoke marshalling.
                    var substitutedOpenTarget = (Binder.SubstituteType(openFunctionParameter, substitution, scope.References.MapClrTypeToReferences) as FunctionTypeSymbol)
                        ?? openFunctionParameter;
                    convertedArgs.Add(lambdas.CreateErasedFunctionLiteralAdapter(functionLiteralArgument, substitutedOpenTarget));
                    continue;
                }

                var expectedType = substitution != null ? Binder.SubstituteType(paramType, substitution, scope.References.MapClrTypeToReferences) : paramType;
                var argLoc = i < ce.Arguments.Count ? ce.Arguments[i].Location : ce.Location;
                convertedArgs.Add(conversions.BindCallArgumentWithRefKind(argLoc, permutedArgs[i], expectedType, method.Parameters[i]));
            }

            // Issue #1209: when the static call dispatches on a constructed
            // generic user type, carry the construction so the emitter parents
            // the call at the construction's TypeSpec (a bare MethodDef token is
            // invalid for a method of a generic type). Null for non-generic
            // receivers leaves the ordinary MethodDef path unchanged.
            // Issue #1433: the same parenting requirement applies to a
            // constructed generic INTERFACE owner; it is carried separately
            // because the emitter resolves interface- and struct-declared
            // statics through different TypeSpec helpers.
            var staticGenericOwner = effectiveStructOwner?.Definition != null ? effectiveStructOwner : null;
            var staticGenericInterfaceOwner = effectiveInterfaceOwner?.Definition != null ? effectiveInterfaceOwner : null;

            // Issue #1931: stash the method's own (explicit or inferred) type
            // arguments on the bound node so the emitter's MethodSpec
            // construction can use this authoritative bind-time result
            // instead of re-deriving it via structural unification (which
            // can fail for uninformative argument shapes like a bare `nil`).
            var methodTypeArguments = default(ImmutableArray<TypeSymbol>);
            if (method.IsGeneric && substitution != null)
            {
                var methodTypeArgsBuilder = ImmutableArray.CreateBuilder<TypeSymbol>(method.TypeParameters.Length);
                foreach (var tp in method.TypeParameters)
                {
                    methodTypeArgsBuilder.Add(substitution[tp]);
                }

                methodTypeArguments = methodTypeArgsBuilder.MoveToImmutable();
            }

            BoundCallExpression MakeStaticGenericCall(TypeSymbol substitutedReturnOverride)
            {
                var result = new BoundCallExpression(null, method, convertedArgs.ToImmutable(), substitutedReturnOverride)
                {
                    StaticGenericOwnerType = staticGenericOwner,
                    StaticGenericInterfaceOwnerType = staticGenericInterfaceOwner,
                    MethodTypeArguments = methodTypeArguments,
                };
                return result;
            }

            if (substitution != null)
            {
                var substitutedReturn = Binder.SubstituteType(method.Type, substitution, scope.References.MapClrTypeToReferences);
                if (method.IsAsync && !isAsyncIteratorReturnType(method.Type))
                {
                    substitutedReturn = lambdas.WrapAsTask(substitutedReturn, method.AsyncReturnsValueTask);
                    return MakeStaticGenericCall(substitutedReturn);
                }

                if (!ReferenceEquals(substitutedReturn, method.Type))
                {
                    return MakeStaticGenericCall(substitutedReturn);
                }
            }

            if (method.IsAsync && !isAsyncIteratorReturnType(method.Type))
            {
                var asyncReturn = lambdas.WrapAsTask(method.Type, method.AsyncReturnsValueTask);
                return MakeStaticGenericCall(asyncReturn);
            }

            return MakeStaticGenericCall(null);
        }

        if (structSym != null
            && TryBindUserStructDelegateMemberInvocation(
                receiver: null,
                structSym,
                methodName,
                arguments,
                ce,
                isStatic: true,
                out var delegateMemberCall))
        {
            return delegateMemberCall;
        }

        if (structSym != null
            && TypeMemberModel.GetNearestImportedBase(structSym)?.ClrType is System.Type importedBase)
        {
            var imported = new ImportedClassSymbol(importedBase, ce, references: scope.References);
            return BindAccessorCall(receiver: null, imported, ce);
        }

        Diagnostics.ReportUnableToFindMember(ce.Location, methodName);
        return new BoundErrorExpression(null);
    }

    private static ImmutableArray<FunctionSymbol> BuildConstructedStaticOverloadGroup(
        StructSymbol lookupType,
        ImmutableArray<FunctionSymbol> methods,
        out Dictionary<FunctionSymbol, FunctionSymbol> originalMethods)
    {
        originalMethods = null;
        if (lookupType == null || methods.Length <= 1)
        {
            return methods;
        }

        var builder = ImmutableArray.CreateBuilder<FunctionSymbol>(methods.Length);
        foreach (var method in methods)
        {
            var owner = method.StaticOwnerType is StructSymbol declaredOwner
                ? TypeMemberModel.ResolveStaticMemberOwner(lookupType, declaredOwner)
                : null;
            if (owner == null || owner.Definition == null)
            {
                if (!builder.Any(existing => BoundScope.FunctionSignaturesEqual(existing, method)))
                {
                    builder.Add(method);
                }

                continue;
            }

            var changed = false;
            var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>(method.Parameters.Length);
            foreach (var parameter in method.Parameters)
            {
                var parameterType = owner.SubstituteMemberType(parameter.Type);
                changed |= !ReferenceEquals(parameterType, parameter.Type);
                var constructedParameter = new ParameterSymbol(
                    parameter.Name,
                    parameterType,
                    parameter.IsVariadic,
                    parameter.DeclaringSyntax,
                    parameter.IsScoped,
                    parameter.RefKind);
                if (parameter.HasExplicitDefaultValue)
                {
                    constructedParameter.SetExplicitDefaultValue(parameter.ExplicitDefaultValue);
                }

                parameters.Add(constructedParameter);
            }

            var returnType = owner.SubstituteMemberType(method.Type);
            changed |= !ReferenceEquals(returnType, method.Type);
            if (!changed)
            {
                if (!builder.Any(existing => BoundScope.FunctionSignaturesEqual(existing, method)))
                {
                    builder.Add(method);
                }

                continue;
            }

            var constructedMethod = new FunctionSymbol(
                method.Name,
                parameters.MoveToImmutable(),
                returnType,
                method.Declaration,
                method.Package,
                method.Accessibility)
            {
                IsStatic = method.IsStatic,
                StaticOwnerType = owner,
                TypeParameters = method.TypeParameters,
                ReturnRefKind = method.ReturnRefKind,
            };
            if (!builder.Any(existing => BoundScope.FunctionSignaturesEqual(existing, constructedMethod)))
            {
                originalMethods ??= new Dictionary<FunctionSymbol, FunctionSymbol>();
                originalMethods.Add(constructedMethod, method);
                builder.Add(constructedMethod);
            }
        }

        return builder.ToImmutable();
    }
}
