// <copyright file="DiagnosticBag.Reports.Declarations.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

partial class DiagnosticBag : IEnumerable[Diagnostic] {
    /// Reports that a parameter with the given name already exists.
    /// @param location The text location where the error was found.
    /// @param parameterName The name of the parameter.
    func ReportParameterAlreadyDeclared(location TextLocation, parameterName string) -> Report(
        location,
        DiagnosticDescriptors.ParameterAlreadyDeclared,
        parameterName
    )

    /// Reports that a symbol is already declared.
    /// @param location The text location where the error was found.
    /// @param name The name of the symbol.
    func ReportSymbolAlreadyDeclared(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.SymbolAlreadyDeclared,
        name
    )

    // ReportMethodReceiverMustBeStructOrClass (GS0103) retired by ADR-0182;
    // see DiagnosticDescriptors.cs.
    /// Issue #4234: reports that a compiler-intrinsic `@ExtensionOwner`
    /// annotation (synthesized by cs2gs to preserve a migrated C# static
    /// extension class's CLR owner-type identity) is malformed or used
    /// outside the one shape it supports: a top-level extension function
    /// carrying a single `typeof(T)` argument naming a non-generic
    /// class declared in the same package.
    /// @param location The text location of the leading `@`.
    /// @param reason A short phrase completing "'@ExtensionOwner' <reason>.".
    func ReportExtensionOwnerInvalid(location TextLocation, reason string) -> Report(
        location,
        DiagnosticDescriptors.ExtensionOwnerInvalid,
        reason
    )

    /// ADR-0184 / issue #376: reports `@UnscopedRef` on a declaration
    /// where it has no meaning — anything that is not a struct instance
    /// member — or on an `override`/interface member, whose
    /// ref-safe-context contract would have to be matched across the whole
    /// override chain (ADR-0184 D4 defers that).
    /// @param location The text location of the offending annotation.
    /// @param reason A short phrase completing "'@UnscopedRef' <reason>.".
    func ReportUnscopedRefInvalidTarget(location TextLocation, reason string) -> Report(
        location,
        DiagnosticDescriptors.UnscopedRefInvalidTarget,
        reason
    )

    /// Reports that a `data class`/`data struct` was declared with
    /// no fields. Zero-field data types are supported as of issue #2363 (see
    /// ADR-0029); this diagnostic is retained for source/API stability in
    /// case a future invalid zero-field shape needs to be rejected, and
    /// reports the actual declaration kind ("class" or "struct") rather than
    /// unconditionally naming it a "struct".
    /// @param location The text location of the struct identifier.
    /// @param name The struct name.
    /// @param isClass True if the declaration is a `class`; false if it is a `struct`.
    func ReportEmptyDataStruct(location TextLocation, name string, isClass bool) {
        let kind = if isClass {
            "class"
        } else {
            "struct"
        }
        Report(location, DiagnosticDescriptors.EmptyDataStruct, kind, name, kind)
    }

    /// Reports that an inline struct does not declare exactly one field.
    /// @param location The text location of the struct identifier.
    /// @param name The struct name.
    /// @param actualCount The actual field count.
    func ReportInlineStructRequiresExactlyOneField(location TextLocation, name string, actualCount int32) -> Report(
        location,
        DiagnosticDescriptors.InlineStructRequiresExactlyOneField,
        name,
        actualCount
    )

    /// Reports that a synthesized inline-struct member was hand-written.
    /// @param location The text location of the member name.
    /// @param typeName The inline struct type name.
    /// @param memberName The synthesized member name.
    func ReportInlineStructSynthesizedMemberConflict(
        location TextLocation,
        typeName string,
        memberName string
    ) -> Report(location, DiagnosticDescriptors.InlineStructSynthesizedMemberConflict, typeName, memberName)

    /// Reports that an enum declaration contains no members.
    /// @param location The text location of the enum identifier.
    /// @param enumName The enum name.
    func ReportEmptyEnumDeclaration(location TextLocation, enumName string) -> Report(
        location,
        DiagnosticDescriptors.EmptyEnumDeclaration,
        enumName
    )

    /// Reports that an enum declares the same member more than once.
    /// @param location The text location of the duplicate member.
    /// @param memberName The duplicate member name.
    /// @param enumName The enum name.
    func ReportDuplicateEnumMember(location TextLocation, memberName string, enumName string) -> Report(
        location,
        DiagnosticDescriptors.DuplicateEnumMember,
        enumName,
        memberName
    )

    /// Reports that an enum member's explicit value (issue #1912) isn't a
    /// constant-foldable int32 expression.
    /// @param location The text location of the value expression.
    /// @param memberName The enum member name.
    /// @param enumName The enum name.
    func ReportEnumMemberValueNotConstant(location TextLocation, memberName string, enumName string) -> Report(
        location,
        DiagnosticDescriptors.EnumMemberValueNotConstant,
        enumName,
        memberName
    )

    /// Issue #946: reports that a property declared both a `set` and an
    /// `init` accessor, which is not allowed (mirrors C#'s rule).
    /// @param location The text location where the error was found.
    /// @param name The name of the property.
    func ReportPropertyHasBothSetAndInit(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.PropertyHasBothSetAndInit,
        name
    )

    /// Issue #946: reports that an `init`-only accessor was declared on a
    /// static property. The `init` accessor is instance-only.
    /// @param location The text location where the error was found.
    /// @param name The name of the property.
    func ReportInitAccessorOnStaticProperty(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.InitAccessorOnStaticProperty,
        name
    )

    /// Reports a variadic parameter (`...T`) that is not the last parameter (Phase 4.8).
    /// @param location The text location of the offending parameter.
    /// @param name The parameter name.
    func ReportVariadicParameterMustBeLast(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.VariadicParameterMustBeLast,
        name
    )

    /// Reports a variadic parameter used in a context that does not yet support it (Phase 4.8 — MVP:
    /// top-level functions only).
    /// @param location The text location of the offending parameter.
    /// @param name The parameter name.
    func ReportVariadicParameterNotSupportedHere(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.VariadicParameterNotSupportedHere,
        name
    )

    /// Reports an interface type-parameter used in a position incompatible with its declared variance
    /// (Phase 4.3c / ADR-0021).
    /// @param location The text location of the offending use.
    /// @param typeParameterName The type-parameter name.
    /// @param declaredVariance The declared variance (in/out).
    /// @param usedPosition The position the type-parameter was used in (input/output).
    func ReportTypeParameterVariancePositionViolation(
        location TextLocation,
        typeParameterName string,
        declaredVariance string,
        usedPosition string
    ) -> Report(
        location,
        DiagnosticDescriptors.TypeParameterVariancePositionViolation,
        typeParameterName,
        declaredVariance,
        usedPosition
    )

    /// Reports a type used as a type-parameter constraint that is neither an interface, a class, nor
    /// another type parameter (issue #1052 generalised the former sealed-interface restriction; issue #1056
    /// additionally permits base-class constraints; issue #4043 additionally permits another type
    /// parameter, so this now fires only for value types such as a struct or enum).
    /// @param location The text location of the constraint reference.
    /// @param typeName The offending type name.
    func ReportConstraintNotInterface(location TextLocation, typeName string) -> Report(
        location,
        DiagnosticDescriptors.ConstraintNotInterface,
        typeName
    )

    /// Issue #4043: reports a circular dependent-constraint chain (`[T T]`, `[A B, B A]`), mirroring C#'s
    /// `CS0454`.
    /// @param location The text location of the constraint reference that closes the cycle.
    /// @param typeParameterName The type parameter the cycle is reported on.
    /// @param constraintName The type parameter its bound names.
    func ReportCircularConstraintDependency(
        location TextLocation,
        typeParameterName string,
        constraintName string
    ) -> Report(location, DiagnosticDescriptors.CircularConstraintDependency, typeParameterName, constraintName)

    /// Issue #948: a `const` field must be given an initializer (a
    /// compile-time constant value). Reported when a `const` field
    /// declaration omits the `= expr` initializer.
    /// @param location The location of the const field identifier.
    /// @param name The const field name.
    func ReportConstFieldRequiresInitializer(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.ConstFieldRequiresInitializer,
        name,
        name
    )

    /// Issue #948: a `const` field initializer must be a compile-time
    /// constant expression. Reported when the bound initializer cannot be
    /// folded to a literal value.
    /// @param location The location of the offending initializer.
    /// @param name The const field name.
    func ReportConstFieldInitializerNotConstant(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.ConstFieldInitializerNotConstant,
        name
    )

    /// Reports a field-emitted constant whose native-width type has no CLR constant representation.
    /// @param location The declared identifier location.
    /// @param name The constant name.
    /// @param typeName The native-width type name.
    func ReportConstNativeIntegerNotSupported(location TextLocation, name string, typeName string) -> Report(
        location,
        DiagnosticDescriptors.ConstNativeIntegerNotSupported,
        name,
        typeName
    )

    /// Issue #3310 / ADR-0159: a bare `chan T` local, global, or field
    /// declared without an initializer has no usable default value (the
    /// magic-collection empty-instance zero values deliberately exclude
    /// channels — buffer size and ownership are semantic decisions
    /// `make` exists to force), so the declaration must initialize it
    /// explicitly.
    /// @param location The location of the declared identifier.
    /// @param name The declared local/global/field name.
    /// @param channelTypeName The channel type name (e.g. `chan int32`), spliced into the suggested `make`
    /// remedy.
    func ReportChannelRequiresInitializer(location TextLocation, name string, channelTypeName string) -> Report(
        location,
        DiagnosticDescriptors.ChannelRequiresInitializer,
        name,
        channelTypeName
    )

    /// Issue #948: an instance field initializer (the `= expr` on a
    /// `let`/`var` field) runs before the constructor body and
    /// therefore cannot reference `this`, other instance members, or
    /// constructor parameters — matching C# field-initializer rules.
    /// @param location The location of the offending reference.
    /// @param memberName The referenced instance member / parameter name.
    func ReportFieldInitializerCannotReferenceInstanceMember(location TextLocation, memberName string) -> Report(
        location,
        DiagnosticDescriptors.FieldInitializerCannotReferenceInstanceMember,
        memberName
    )

    /// Reports instance access before a base or delegating constructor has run.
    /// @param location The offending reference location.
    /// @param memberName The referenced instance member name.
    func ReportConstructorInitializerCannotReferenceInstanceMember(location TextLocation, memberName string) -> Report(
        location,
        DiagnosticDescriptors.ConstructorInitializerCannotReferenceInstanceMember,
        memberName
    )

    /// ADR-0068 / issue #698: reports a `deinit` destructor declaration
    /// on a non-class type. `deinit` lowers to a CLR finalizer, which
    /// the CLR does not run for value types, so it is only legal inside a
    /// `class` body.
    /// @param location The location of the offending `deinit` keyword.
    /// @param typeName The enclosing type's name (may be empty).
    /// @param enclosingKind The enclosing type-introducer keyword (`struct`, etc.).
    func ReportDeinitOnNonClass(location TextLocation, typeName string, enclosingKind SyntaxKind) {
        let kindText = if enclosingKind == SyntaxKind.StructKeyword {
            "struct"
        } else {
            enclosingKind.ToString()
        }
        let typeText = if string.IsNullOrEmpty(typeName) {
            "this type"
        } else {
            "'" + typeName + "'"
        }
        Report(location, DiagnosticDescriptors.DeinitOnNonClass, typeText, kindText)
    }

    /// ADR-0068 / issue #698: reports a duplicate `deinit` declaration
    /// on the same class. A class instance is finalized at most once by the
    /// CLR garbage collector, so only one `deinit` body may be emitted
    /// as the type's `Finalize` override.
    /// @param location The location of the duplicate `deinit` keyword.
    /// @param className The enclosing class's name.
    func ReportDuplicateDeinit(location TextLocation, className string) {
        let classText = if string.IsNullOrEmpty(className) {
            "this class"
        } else {
            "Class '" + className + "'"
        }
        Report(location, DiagnosticDescriptors.DuplicateDeinit, classText)
    }

    /// ADR-0068 / issue #698: reports a `deinit` declaration that
    /// carries a parameter list. Destructors take no parameters — the CLR
    /// invokes `Finalize()` with no arguments.
    /// @param location The location of the offending open paren.
    func ReportDeinitMayNotDeclareParameters(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.DeinitMayNotDeclareParameters
    )

    /// ADR-0068 / issue #698: reports a `deinit` declaration that
    /// carries a return type. Destructors always return `void` — the
    /// CLR's `Finalize` override may not return a value.
    /// @param location The location of the offending return type token.
    func ReportDeinitMayNotDeclareReturnType(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.DeinitMayNotDeclareReturnType
    )

    /// Issue #950: GS0380 — the `protected` modifier appears on a member
    /// (or nested type) whose enclosing type is not an inheritable
    /// `open class`. Nothing can derive from a non-`open` class, a
    /// `struct`, a sealed type, an interface, or a top-level declaration,
    /// so `protected` there is meaningless.
    /// @param location The text location of the `protected` modifier.
    func ReportProtectedRequiresOpenType(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.ProtectedRequiresOpenType
    )

    /// Reports an attempt to subclass a sealed (non-`open`) class. Phase 3.B.3 sub-step 3 / ADR-0017.
    /// @param location The text location of the base-type identifier.
    /// @param baseTypeName The base type name.
    func ReportBaseClassNotOpen(location TextLocation, baseTypeName string) -> Report(
        location,
        DiagnosticDescriptors.BaseClassNotOpen,
        baseTypeName,
        baseTypeName
    )

    /// Issue #949: reports a class that directly names itself as its own base
    /// class (e.g. `class A : A` or the generic `class A[T] : A[T]`),
    /// which is an illegal self-inheritance cycle. Note that naming the
    /// enclosing type merely as a generic type argument of a base/interface
    /// type — the common `class Shape : IEquatable[Shape]` pattern — is
    /// legal and is not reported here.
    /// @param location The text location of the base-type identifier.
    /// @param typeName The declaring type name.
    func ReportClassInheritsFromItself(location TextLocation, typeName string) -> Report(
        location,
        DiagnosticDescriptors.ClassInheritsFromItself,
        typeName
    )

    /// Issue #973: reports a class that participates in a transitive base-class
    /// inheritance cycle (e.g. `class B : C` together with
    /// `class C : B`). The two-phase declaration model (#973) declares all
    /// type-name shells before binding any base clause, so such mutually
    /// forward-referencing cycles can no longer be screened out by declaration
    /// order and must be detected explicitly once every base class is resolved.
    /// Direct self-inheritance (`class A : A`) is reported separately by
    /// (cref:ReportClassInheritsFromItself).
    /// @param location The text location of the base-type clause.
    /// @param typeName The declaring type name.
    func ReportClassInheritanceCycle(location TextLocation, typeName string) -> Report(
        location,
        DiagnosticDescriptors.ClassInheritanceCycle,
        typeName
    )

    /// Issue #976: GS0382 — a `struct` (value type) named a class or
    /// another struct in its `: …` clause. A CLR value type always derives
    /// from `System.ValueType` and cannot declare a user base type; its
    /// clause may list interfaces only.
    /// @param location The text location of the offending base type.
    /// @param structName The declaring struct's name.
    /// @param baseTypeName The illegal base type's name.
    func ReportStructCannotHaveBaseClass(location TextLocation, structName string, baseTypeName string) -> Report(
        location,
        DiagnosticDescriptors.StructCannotHaveBaseClass,
        structName,
        baseTypeName
    )

    /// Issue #1006: GS0391 — an `interface` named a class or struct in its
    /// base-interface clause (e.g. `interface B : SomeClass`). An
    /// interface may only extend other interfaces.
    /// @param location The text location of the offending base type.
    /// @param interfaceName The declaring interface's name.
    /// @param baseTypeName The illegal base type's name.
    func ReportInterfaceCannotHaveClassBase(location TextLocation, interfaceName string, baseTypeName string) -> Report(
        location,
        DiagnosticDescriptors.InterfaceCannotHaveClassBase,
        interfaceName,
        baseTypeName
    )

    /// Reports base-constructor arguments (`: Base(args)`) on a class that declares no base class (issue
    /// #306).
    /// @param location The text location of the base-constructor argument list.
    func ReportBaseConstructorArgumentsWithoutBase(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.BaseConstructorArgumentsWithoutBase
    )

    /// Reports that no accessible base constructor matches the supplied base-constructor arguments (issue
    /// #306).
    /// @param location The text location of the base-constructor argument list.
    /// @param baseTypeName The base type name.
    /// @param argumentCount The number of supplied arguments.
    func ReportNoMatchingBaseConstructor(location TextLocation, baseTypeName string, argumentCount int32) -> Report(
        location,
        DiagnosticDescriptors.NoMatchingBaseConstructor,
        baseTypeName,
        argumentCount
    )

    /// Reports a class that declares both a Kotlin-style primary constructor and an explicit `init(...)`
    /// constructor (issue #306).
    /// @param location The text location of the offending `init` declaration.
    /// @param className The class name.
    func ReportPrimaryAndExplicitConstructors(location TextLocation, className string) -> Report(
        location,
        DiagnosticDescriptors.PrimaryAndExplicitConstructors,
        className
    )

    /// Reports a class that declares more than one explicit `init(...)` constructor, which is not yet
    /// supported (issue #306).
    /// @param location The text location of the offending `init` declaration.
    /// @param className The class name.
    func ReportMultipleConstructorsUnsupported(location TextLocation, className string) -> Report(
        location,
        DiagnosticDescriptors.MultipleConstructorsUnsupported,
        className
    )

    /// Reports a method that overrides a base method without using `override`. ADR-0017.
    /// @param location The text location of the offending declaration.
    /// @param baseTypeName The base type name.
    /// @param methodName The method name.
    func ReportMissingOverride(location TextLocation, baseTypeName string, methodName string) -> Report(
        location,
        DiagnosticDescriptors.MissingOverride,
        baseTypeName,
        methodName
    )

    /// Reports an `override` method that does not match any open base method. ADR-0017.
    /// @param location The text location of the offending declaration.
    /// @param methodName The method name.
    func ReportNoBaseMethodToOverride(location TextLocation, methodName string) -> Report(
        location,
        DiagnosticDescriptors.NoBaseMethodToOverride,
        methodName
    )

    /// Reports an `override` targeting a method that is not `open` (sealed override). ADR-0017.
    /// @param location The text location of the offending declaration.
    /// @param methodName The method name.
    func ReportOverrideOfSealedMethod(location TextLocation, methodName string) -> Report(
        location,
        DiagnosticDescriptors.OverrideOfSealedMethod,
        methodName
    )

    /// Reports a signature mismatch between an `override` method and its base method.
    /// @param location The text location of the offending declaration.
    /// @param methodName The method name.
    func ReportOverrideSignatureMismatch(location TextLocation, methodName string) -> Report(
        location,
        DiagnosticDescriptors.OverrideSignatureMismatch,
        methodName
    )

    /// ADR-0085 (issue #726): GS0186 — previously reported when an interface
    /// method carried a body in Phase 3 (ADR-0018 deferral). The deferral was
    /// reversed by ADR-0085, which implements default-interface methods, so
    /// this diagnostic is no longer emitted. The slot is preserved (rather
    /// than reused) so historical references in changelogs and PRs still
    /// resolve correctly.
    /// @param location The text location of the offending method identifier.
    /// @param methodName The method name.
    func ReportInterfaceMethodHasBody(location TextLocation, methodName string) -> Report(
        location,
        DiagnosticDescriptors.InterfaceMethodHasBody,
        methodName
    )

    /// Reports an aggregate that fails to implement an interface method.
    /// @param location The text location of the aggregate identifier.
    /// @param implementer The implementing class or struct.
    /// @param interfaceName The interface name.
    /// @param methodName The missing method.
    func ReportInterfaceMethodNotImplemented(
        location TextLocation,
        implementer StructSymbol,
        interfaceName string,
        methodName string
    ) -> Report(
        location,
        DiagnosticDescriptors.InterfaceMethodNotImplemented,
        GetAggregateKindName(implementer),
        implementer.Name,
        interfaceName,
        methodName
    )

    /// Phase 3.B.5: reports an aggregate that implements a sealed interface declared in a different
    /// package.
    /// @param location The text location of the implementing aggregate identifier.
    /// @param implementer The implementing class or struct.
    /// @param interfaceName The sealed interface name.
    /// @param interfacePackage The package owning the sealed interface.
    func ReportSealedInterfaceImplementorOutsidePackage(
        location TextLocation,
        implementer StructSymbol,
        interfaceName string,
        interfacePackage string
    ) -> Report(
        location,
        DiagnosticDescriptors.SealedInterfaceImplementorOutsidePackage,
        GetAggregateKindName(implementer),
        implementer.Name,
        interfaceName,
        interfacePackage
    )

    /// ADR-0051: reports an `open` member declared on a class that is not itself `open`.
    /// @param location The text location of the `open` modifier.
    /// @param memberName The member name.
    func ReportOpenMemberInNonOpenClass(location TextLocation, memberName string) -> Report(
        location,
        DiagnosticDescriptors.OpenMemberInNonOpenClass,
        memberName
    )

    /// Reports that an `async func(...)` type clause has an explicit
    /// `Task[…]` (or other Task-shaped) return type. The `async`
    /// modifier already implies a Task wrap, so the explicit wrap is
    /// disallowed (ADR-0043).
    /// @param location The text location of the offending return-type clause.
    /// @param returnTypeName The name of the explicit return type.
    func ReportAsyncFunctionTypeClauseHasExplicitTaskReturn(location TextLocation, returnTypeName string) -> Report(
        location,
        DiagnosticDescriptors.AsyncFunctionTypeClauseHasExplicitTaskReturn,
        returnTypeName
    )

    /// GS9007: A type may contain at most one 'shared' block.
    /// @param location The text location of the duplicate shared keyword.
    func ReportDuplicateSharedBlock(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.DuplicateSharedBlock
    )

    /// Issue #410 / ADR-0029: reports that a synthesized data-struct member
    /// (`Equals`, `GetHashCode`, `ToString`, `op_Equality`,
    /// `op_Inequality`, or `Deconstruct`) was hand-written. The ADR
    /// forbids user-written versions so the contract of `data struct` is
    /// learnable and predictable.
    /// @param location The text location of the member name.
    /// @param typeName The data type name.
    /// @param isClass `true` when the type is a data class; otherwise a data struct.
    /// @param memberName The synthesized member name.
    func ReportDataStructSynthesizedMemberConflict(
        location TextLocation,
        typeName string,
        isClass bool,
        memberName string
    ) {
        let kind = if isClass {
            "class"
        } else {
            "struct"
        }
        Report(location, DiagnosticDescriptors.DataStructSynthesizedMemberConflict, kind, typeName, memberName)
    }

    /// Issue #2361 / ADR-0029 follow-up: reports that a data class/struct's
    /// hand-written `ToString` declaration is incompatible with the slot
    /// it would need to suppress/replace (`public string ToString()` —
    /// zero parameters, non-static, non-generic, non-async, returning
    /// `string`). Unlike the other five synthesized names (which are
    /// always rejected via (cref:ReportDataStructSynthesizedMemberConflict)),
    /// a `ToString` declaration gets this more specific diagnostic so the
    /// message can describe the exact shape it must match.
    /// @param location The text location of the member name.
    /// @param typeName The data type name.
    /// @param isClass `true` when the type is a data class; otherwise a data struct.
    func ReportIncompatibleDataToStringOverride(location TextLocation, typeName string, isClass bool) {
        let kind = if isClass {
            "class"
        } else {
            "struct"
        }
        Report(location, DiagnosticDescriptors.IncompatibleDataToStringOverride, kind, typeName, kind)
    }

    /// ADR-0060 §8: reports that an override or interface-implementation method's parameter
    /// ref-kind does not match the base/interface declaration.
    /// @param location The location of the overriding declaration.
    /// @param memberName The member name.
    /// @param parameterName The parameter name.
    /// @param expected The expected ref-kind ("none", "ref", "out", "in").
    /// @param actual The actual ref-kind ("none", "ref", "out", "in").
    func ReportOverrideRefKindMismatch(
        location TextLocation,
        memberName string,
        parameterName string,
        expected string,
        actual string
    ) -> Report(location, DiagnosticDescriptors.OverrideRefKindMismatch, memberName, parameterName, expected, actual)

    /// ADR-0060 §8: reports a variadic parameter (`...T`) declared with a ref-kind modifier.
    /// The combination is forbidden — the CLR cannot express an array of by-ref values.
    /// @param location The parameter location.
    /// @param parameterName The parameter name.
    func ReportRefKindOnVariadicParameter(location TextLocation, parameterName string) -> Report(
        location,
        DiagnosticDescriptors.RefKindOnVariadicParameter,
        parameterName
    )

    /// ADR-0060 + ADR-0029: rejects a ref-kind modifier on a primary-constructor parameter.
    /// Primary-constructor parameters materialize fields, and the CLR cannot encode a
    /// managed-pointer (`T&`) as a field type. The user must drop the modifier or
    /// move the constructor body to a standalone `init(...)` that does not synthesize
    /// a backing field.
    /// @param location The ref-kind modifier location.
    /// @param parameterName The parameter name.
    func ReportRefKindOnPrimaryCtorParameter(location TextLocation, parameterName string) -> Report(
        location,
        DiagnosticDescriptors.RefKindOnPrimaryCtorParameter,
        parameterName
    )

    /// ADR-0060 §10: reports a ref-kind parameter on an `async`, `sequence`, or
    /// `async sequence` function. The state-machine rewriter cannot hoist a managed
    /// pointer into a field, so the parameter is rejected.
    /// @param location The parameter location.
    /// @param parameterName The parameter name.
    /// @param functionKind "async", "sequence", or "async sequence".
    func ReportRefKindOnAsyncOrIterator(location TextLocation, parameterName string, functionKind string) -> Report(
        location,
        DiagnosticDescriptors.RefKindOnAsyncOrIterator,
        parameterName,
        functionKind
    )

    /// Issue #490 (ADR-0060 §9 extension): the overriding / interface-implementing method
    /// disagrees with the base/interface declaration on whether the return is by reference.
    /// @param location The location of the overriding declaration.
    /// @param memberName The member name.
    /// @param expected The expected return ref-kind text (e.g. "ref" or "by value").
    /// @param actual The actual return ref-kind text on the derived/implementing declaration.
    func ReportOverrideReturnRefKindMismatch(
        location TextLocation,
        memberName string,
        expected string,
        actual string
    ) -> Report(location, DiagnosticDescriptors.OverrideReturnRefKindMismatch, memberName, expected, actual)

    /// ADR-0063: reports a second user-defined callable declaration whose signature
    /// (parameter types + ref-kinds, excluding defaults and return type) duplicates an
    /// already-declared overload in the same declaration space.
    /// @param location The location of the offending declaration.
    /// @param name The callable name.
    /// @param signature A short rendering of the duplicated signature.
    func ReportDuplicateOverloadSignature(location TextLocation, name string, signature string) -> Report(
        location,
        DiagnosticDescriptors.DuplicateOverloadSignature,
        name,
        signature
    )

    /// ADR-0063 §3: reports an optional-parameter declaration that violates a v1
    /// restriction (non-constant default, optional `ref`/`out`/`in`, optional
    /// variadic, default on the receiver parameter, or unrepresentable constant for
    /// the parameter type).
    /// @param location The location of the offending parameter clause.
    /// @param parameterName The parameter's source name.
    /// @param reason A short, user-visible reason for the rejection.
    func ReportInvalidOptionalParameter(location TextLocation, parameterName string, reason string) -> Report(
        location,
        DiagnosticDescriptors.InvalidOptionalParameter,
        parameterName,
        reason
    )

    /// ADR-0065 §2: GS0278 — a `convenience init` body must begin with a
    /// self-delegation `init(args)` call.
    /// @param location The source location of the convenience init declaration.
    /// @param className The owning class.
    func ReportConvenienceInitMustDelegate(location TextLocation, className string) -> Report(
        location,
        DiagnosticDescriptors.ConvenienceInitMustDelegate,
        className
    )

    /// ADR-0065 §2: GS0279 — a `convenience init` may not declare an
    /// explicit `: base(args)` clause; convenience initializers must
    /// chain to another initializer in the same class, which transitively
    /// reaches a designated initializer that performs the base call.
    /// @param location The source location of the `: base` clause.
    /// @param className The owning class.
    func ReportConvenienceInitMayNotCallBase(location TextLocation, className string) -> Report(
        location,
        DiagnosticDescriptors.ConvenienceInitMayNotCallBase,
        className
    )

    /// ADR-0065 §2: GS0280 — `init(args)` self-delegation only appears
    /// inside a constructor body of a class.
    /// @param location The source location of the self-delegation call.
    func ReportInitDelegationOutsideCtor(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.InitDelegationOutsideCtor
    )

    /// ADR-0065 §2: GS0281 — `init(args)` self-delegation is only legal
    /// inside a `convenience init`; designated initializers must chain
    /// to the base class with `: base(args)` instead.
    /// @param location The source location of the self-delegation call.
    /// @param className The owning class.
    func ReportInitDelegationFromDesignated(location TextLocation, className string) -> Report(
        location,
        DiagnosticDescriptors.InitDelegationFromDesignated,
        className
    )

    /// ADR-0065 §2: GS0282 — `init(args)` self-delegation must target a
    /// different constructor than the one being executed; recursive delegation
    /// would loop indefinitely.
    /// @param location The source location of the self-delegation call.
    /// @param className The owning class.
    func ReportInitDelegationRecursive(location TextLocation, className string) -> Report(
        location,
        DiagnosticDescriptors.InitDelegationRecursive,
        className
    )

    /// ADR-0065 §2: GS0283 — overload resolution found no matching sibling
    /// initializer for an `init(args)` self-delegation call.
    /// @param location The source location of the self-delegation call.
    /// @param className The owning class.
    func ReportInitDelegationNoMatch(location TextLocation, className string) -> Report(
        location,
        DiagnosticDescriptors.InitDelegationNoMatch,
        className
    )

    /// ADR-0065 §5: GS0284 — a user-declared `init(...)` overload has the
    /// same signature as the constructor synthesized from the type's primary
    /// constructor parameter list.
    /// @param location The source location of the offending `init` declaration.
    /// @param className The owning type.
    /// @param signature The signature description.
    func ReportInitDuplicatesPrimaryCtor(location TextLocation, className string, signature string) -> Report(
        location,
        DiagnosticDescriptors.InitDuplicatesPrimaryCtor,
        signature,
        className
    )

    // ReportReceiverClauseOnOwnedType (GS0314) retired by ADR-0182; see
    // DiagnosticDescriptors.cs.
    /// ADR-0085 / issue #726: GS0318 — an aggregate implements two unrelated
    /// interfaces that each provide a default body for the same method
    /// signature, and the aggregate does not declare its own override. The
    /// implementer must declare a same-name same-signature method to
    /// disambiguate (Java-style "explicit override" rule). The message
    /// names both interfaces and the disputed method so the fix is
    /// immediately apparent.
    /// @param location The source location of the implementing aggregate identifier.
    /// @param implementer The implementing class or struct.
    /// @param methodName The disputed method name.
    /// @param firstInterfaceName The name of the first interface providing a default.
    /// @param secondInterfaceName The name of the second interface providing a default.
    func ReportConflictingInterfaceDefaults(
        location TextLocation,
        implementer StructSymbol,
        methodName string,
        firstInterfaceName string,
        secondInterfaceName string
    ) -> Report(
        location,
        DiagnosticDescriptors.ConflictingInterfaceDefaults,
        GetAggregateKindName(implementer),
        implementer.Name,
        methodName,
        firstInterfaceName,
        secondInterfaceName,
        implementer.Name
    )

    /// ADR-0085 / issue #726: GS0319 — a call site (or override) references
    /// an interface method that has been turned back into an abstract slot
    /// (its default body was removed in a later library version), and the
    /// implementer was relying on the inherited default. The binder fires
    /// this when an InterfaceImpl is satisfied solely through a default that
    /// has been replaced by an abstract signature. Reserved so binary-compat
    /// regressions surface with a dedicated, actionable error.
    /// @param location The source location of the implementing aggregate identifier.
    /// @param implementer The implementing class or struct.
    /// @param interfaceName The interface that dropped the default.
    /// @param methodName The method that lost its default body.
    func ReportInterfaceDefaultRemoved(
        location TextLocation,
        implementer StructSymbol,
        interfaceName string,
        methodName string
    ) -> Report(
        location,
        DiagnosticDescriptors.InterfaceDefaultRemoved,
        GetAggregateKindName(implementer),
        implementer.Name,
        interfaceName,
        methodName,
        implementer.Name
    )

    /// ADR-0085 / issue #726: GS0320 — an aggregate declares `: I` but
    /// neither provides an implementation of an abstract method `M`
    /// declared on `I` nor inherits one through its class chain, and
    /// the interface deliberately marked `M` abstract (no default
    /// body). This is the "no default, no impl" anchor that complements
    /// the general GS0187 channel; it fires when DIM is *available* but
    /// not used to bridge the gap, so users see immediately that the
    /// interface intentionally requires an implementation.
    /// @param location The source location of the implementing aggregate identifier.
    /// @param implementer The implementing class or struct.
    /// @param interfaceName The interface declaring the abstract method.
    /// @param methodName The abstract method name.
    func ReportInterfaceAbstractMethodHasNoDefault(
        location TextLocation,
        implementer StructSymbol,
        interfaceName string,
        methodName string
    ) -> Report(
        location,
        DiagnosticDescriptors.InterfaceAbstractMethodHasNoDefault,
        GetAggregateKindName(implementer),
        implementer.Name,
        interfaceName,
        methodName
    )

    /// ADR-0085 / issue #726: GS0321 — a deferred modifier (currently
    /// `static` or `private`) appears on an interface method
    /// declaration. ADR-0085 intentionally keeps DIM minimal in this PR
    /// (instance-virtual default methods only); static-virtuals and
    /// private helpers are tracked as follow-ups and are rejected here.
    /// @param location The source location of the offending modifier or method identifier.
    /// @param modifier The triggering modifier (e.g. `static`, `private`).
    /// @param methodName The owning interface method name.
    func ReportInterfaceMethodModifierDeferred(location TextLocation, modifier string, methodName string) -> Report(
        location,
        DiagnosticDescriptors.InterfaceMethodModifierDeferred,
        modifier,
        methodName
    )

    /// Reports GS0361 — ADR-0097 / issue #775: a type-parameter constraint
    /// list combines mutually exclusive flag constraints. The forbidden
    /// combinations are `class struct` (a type cannot simultaneously
    /// be a reference type and a value type) and `struct init()` (the
    /// `init()` flag is implied by — and redundant with — `struct`
    /// at the CLR level; ECMA-335 II.10.1.7 already forces both bits
    /// whenever the value-type constraint is set, so the explicit
    /// `init()` is rejected to keep the surface unambiguous).
    /// @param location The offending constraint location.
    /// @param typeParameterName The type-parameter name (e.g. `T`).
    /// @param first The first constraint keyword (e.g. `class`).
    /// @param second The second constraint keyword (e.g. `struct`).
    func ReportTypeParameterConstraintConflict(
        location TextLocation,
        typeParameterName string,
        first string,
        second string
    ) -> Report(location, DiagnosticDescriptors.TypeParameterConstraintConflict, typeParameterName, first, second)

    /// Reports GS0364 — ADR-0101 / issue #799: more than one variadic
    /// parameter (`...T`) appeared in the same parameter list. A signature
    /// may declare at most one variadic parameter, and it must be the last
    /// parameter.
    /// @param location The location of the second (or later) variadic parameter.
    /// @param name The offending parameter name.
    func ReportMultipleVariadicParameters(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.MultipleVariadicParameters,
        name
    )

    /// Reports GS0365 — ADR-0102 follow-up / issue #818: a variadic
    /// parameter slot in an anonymous function-type clause
    /// (`(T1, ...T2) -> R`) must spell its element type with the
    /// slice form `[]T`. The `...` marker turns the slot into a
    /// pack/passthrough call site, so the storage type must be a slice the
    /// trailing positional arguments can pack into.
    /// @param location The location of the offending parameter type clause.
    /// @param typeName The non-slice type name that was supplied.
    func ReportVariadicParameterMustBeSlice(location TextLocation, typeName string) -> Report(
        location,
        DiagnosticDescriptors.VariadicParameterMustBeSlice,
        typeName
    )

    /// Reports GS0330 — ADR-0089 / issue #755 (issue #865 revision): a
    /// non-`func` member appears inside an interface `shared { … }`
    /// block. Only static-virtual `func` members (abstract or default) are
    /// allowed there; interface static state (`var` / `let` /
    /// `const` / `prop` / `event`) is deferred to a future ADR.
    /// @param location The source location of the offending declaration.
    /// @param interfaceName The owning interface name.
    func ReportInterfaceSharedMemberMustBeFunc(location TextLocation, interfaceName string) -> Report(
        location,
        DiagnosticDescriptors.InterfaceSharedMemberMustBeFunc,
        interfaceName
    )

    /// Reports GS0396 — ADR-0089 / issue #1019: a static-virtual interface
    /// property declared inside an interface `shared { … }` block carries
    /// an accessor *body* (a default static slot). Default-bodied static
    /// interface properties are deferred (interface properties are abstract
    /// slots only in this release); declare an abstract slot
    /// (`prop Name T { get; }` / `prop Name T;`) instead, or expose a
    /// default via a static `func` in the interface shared block.
    /// @param location The offending accessor location.
    /// @param interfaceName The owning interface name.
    /// @param propertyName The static interface property name.
    func ReportDefaultStaticInterfacePropertyNotSupported(
        location TextLocation,
        interfaceName string,
        propertyName string
    ) -> Report(
        location,
        DiagnosticDescriptors.DefaultStaticInterfacePropertyNotSupported,
        interfaceName,
        propertyName,
        propertyName
    )

    /// Reports GS0397 — ADR-0089 / issue #1019: a struct/class that declares it
    /// implements an interface with one or more static-virtual abstract
    /// *properties* does not provide a matching static property (in its own
    /// `shared { … }` block) for some of those slots.
    /// @param location The implementer declaration head location.
    /// @param structName The implementer type name.
    /// @param interfaceName The interface symbol display.
    /// @param propertyName The unimplemented static-virtual property name.
    /// @param detail A short clause describing what is missing (e.g. "getter").
    func ReportStaticVirtualInterfacePropertyNotImplemented(
        location TextLocation,
        structName string,
        interfaceName string,
        propertyName string,
        detail string
    ) -> Report(
        location,
        DiagnosticDescriptors.StaticVirtualInterfacePropertyNotImplemented,
        structName,
        interfaceName,
        propertyName,
        detail
    )

    /// Reports GS0331 — ADR-0089 / issue #755: an aggregate that declares it
    /// implements an interface with one or more static-virtual abstract
    /// members does not provide the matching `shared { func … }`
    /// override for some of those slots.
    /// @param location The aggregate declaration head location.
    /// @param implementer The implementing class or struct.
    /// @param interfaceName The interface symbol display.
    /// @param methodName The unimplemented static-virtual method name.
    func ReportStaticVirtualInterfaceMethodNotImplemented(
        location TextLocation,
        implementer StructSymbol,
        interfaceName string,
        methodName string
    ) -> Report(
        location,
        DiagnosticDescriptors.StaticVirtualInterfaceMethodNotImplemented,
        GetAggregateKindName(implementer),
        implementer.Name,
        interfaceName,
        methodName
    )

    /// Reports GS0332 — ADR-0089 / issue #755: an aggregate declares a
    /// non-`static` instance method with the same name and signature
    /// as a static-virtual interface slot. Instance methods cannot satisfy
    /// a static-virtual contract; the implementer must declare the method
    /// inside a `shared { ... }` block (ADR-0053) with the matching
    /// signature.
    /// @param location The offending instance-method declaration location.
    /// @param implementer The implementing class or struct.
    /// @param interfaceName The interface symbol display.
    /// @param methodName The interface slot name.
    func ReportNonStaticMemberForStaticVirtualSlot(
        location TextLocation,
        implementer StructSymbol,
        interfaceName string,
        methodName string
    ) -> Report(
        location,
        DiagnosticDescriptors.NonStaticMemberForStaticVirtualSlot,
        GetAggregateKindName(implementer),
        implementer.Name,
        methodName,
        interfaceName,
        methodName
    )

    /// ADR-0090 / issue #756: GS0335 — a `private` interface method was
    /// declared without a body. A private helper is part of the interface's
    /// own implementation and must therefore supply one; no implementer is
    /// allowed to satisfy the contract because no implementer is allowed to
    /// see the slot.
    /// @param location The offending method-identifier location.
    /// @param methodName The helper's name.
    func ReportPrivateInterfaceMemberRequiresBody(location TextLocation, methodName string) -> Report(
        location,
        DiagnosticDescriptors.PrivateInterfaceMemberRequiresBody,
        methodName
    )

    /// ADR-0090 / issue #756: GS0336 — an implementing class or struct
    /// declared a method whose name + signature matches a `private`
    /// helper on one of its implemented interfaces. Private helpers are
    /// invisible to implementers; declaring a same-name method is almost
    /// always an unintentional clash.
    /// @param location The offending member's identifier location.
    /// @param implementerName The implementing class / struct name.
    /// @param interfaceName The interface owning the helper.
    /// @param methodName The clashing method name.
    func ReportImplementerOverridesPrivateInterfaceMember(
        location TextLocation,
        implementerName string,
        interfaceName string,
        methodName string
    ) -> Report(
        location,
        DiagnosticDescriptors.ImplementerOverridesPrivateInterfaceMember,
        implementerName,
        methodName,
        interfaceName,
        methodName,
        methodName,
        implementerName
    )

    /// ADR-0090 / issue #756: GS0337 — a `private` modifier appears on
    /// an interface property or event declaration. ADR-0090 deliberately
    /// keeps the surface to `private func`; private interface
    /// properties / events are out of scope for this release.
    /// @param location The offending modifier's source location.
    /// @param memberKind The offending member kind (`property` / `event`).
    /// @param memberName The owning member's name.
    func ReportPrivateInterfaceMemberKindNotSupported(
        location TextLocation,
        memberKind string,
        memberName string
    ) -> Report(location, DiagnosticDescriptors.PrivateInterfaceMemberKindNotSupported, memberKind, memberName)

    /// ADR-0144 / issue #2201: GS0484 — the `partial` contextual modifier
    /// was applied to an aggregate kind that cannot be partial. Only
    /// `class`, `struct`, and `interface` declarations may be
    /// partial; `enum` is rejected at parse time.
    /// @param location The source location of the offending `partial` modifier.
    /// @param kind The rejected aggregate kind spelling (e.g. `enum`).
    func ReportPartialNotValidOnKind(location TextLocation, kind string) -> Report(
        location,
        DiagnosticDescriptors.PartialNotValidOnKind,
        kind
    )

    /// ADR-0192 / issue #4301: GS0607 — the `partial` contextual modifier
    /// appeared somewhere a partial member cannot be declared: on a top-level
    /// `func`, on an interface method signature, or on a `prop` /
    /// `event` / `init` member. Only a `func` inside a
    /// `partial class` or `partial struct` may be partial.
    /// @param location The source location of the offending `partial` modifier.
    func ReportPartialModifierNotValidHere(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.PartialModifierNotValidHere
    )

    /// ADR-0192 / issue #4301: GS0608 — a `partial func` was declared in a
    /// type that is not itself `partial` (the analog of C# CS0751).
    /// Reported by `PartialMethodMerger` rather than the parser, because
    /// the enclosing declaration's `partial` modifier is only attached
    /// after its member list has been parsed.
    /// @param location The source location of the partial method's identifier.
    /// @param name The method name.
    func ReportPartialMethodRequiresPartialType(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.PartialMethodRequiresPartialType,
        name
    )

    /// ADR-0192 / issue #4301: GS0609 — a partial method has a declaring part
    /// but no implementing part. G# diverges from C# here: C# silently elides
    /// an unimplemented `void` partial method (and its call sites),
    /// whereas G# requires an implementation, matching how every other
    /// body-less G# declaration is diagnosed when nothing satisfies it
    /// (ADR-0086 §1 / GS0325).
    /// @param location The source location of the declaring part's identifier.
    /// @param name The method name.
    func ReportPartialMethodHasNoImplementation(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.PartialMethodHasNoImplementation,
        name
    )

    /// ADR-0192 / issue #4301: GS0610 — the parts of a partial method do not
    /// form the required one-declaring/one-implementing pair (for example two
    /// bodies, two signature-only parts, or an implementing part with no
    /// declaring part).
    /// @param location The source location of the offending part's identifier.
    /// @param name The method name.
    /// @param declaringCount How many signature-only declaring parts were found.
    /// @param implementingCount How many parts supplied a body.
    func ReportPartialMethodPartCount(
        location TextLocation,
        name string,
        declaringCount int32,
        implementingCount int32
    ) -> Report(location, DiagnosticDescriptors.PartialMethodPartCount, name, declaringCount, implementingCount)

    /// ADR-0192 / issue #4301: GS0611 — the declaring and implementing parts of
    /// a partial method disagree on some aspect of their signature or modifier
    /// set (return type, parameter names/modifiers, accessibility,
    /// `open`/`override`, `ref` return, generic parameters, …).
    /// @param location The source location of the implementing part's identifier.
    /// @param name The method name.
    /// @param aspect A short description of the aspect the parts disagree on.
    func ReportPartialMethodPartsDisagree(location TextLocation, name string, aspect string) -> Report(
        location,
        DiagnosticDescriptors.PartialMethodPartsDisagree,
        name,
        aspect
    )

    /// ADR-0144 / issue #2201: GS0475 — a declaration in a partial-type group
    /// lacks the `partial` modifier while another declaration of the same
    /// type carries it (the analog of C# CS0260).
    /// @param location The source location of the non-partial declaration's identifier.
    /// @param name The type name.
    func ReportPartialModifierMissing(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.PartialModifierMissing,
        name
    )

    /// ADR-0144 / issue #2201: GS0476 — the parts of a partial type disagree on
    /// aggregate kind (`class` vs `struct` vs `interface`).
    /// @param location The source location of the mismatched declaration's identifier.
    /// @param name The type name.
    func ReportPartialKindMismatch(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.PartialKindMismatch,
        name
    )

    /// ADR-0144 / issue #2201: GS0477 — two parts of a partial type state
    /// different accessibility modifiers.
    /// @param location The source location of the conflicting accessibility modifier.
    /// @param name The type name.
    func ReportPartialAccessibilityConflict(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.PartialAccessibilityConflict,
        name
    )

    /// ADR-0144 / issue #2201: GS0478 — one part of a partial type is `open`
    /// and another is `sealed`.
    /// @param location The source location of the conflicting declaration's identifier.
    /// @param name The type name.
    func ReportPartialOpenSealedConflict(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.PartialOpenSealedConflict,
        name
    )

    /// ADR-0144 / issue #2201: GS0479 — a `data`/`inline`/`ref`
    /// modifier that changes how each part's body binds appears on some but not
    /// all parts of a partial type.
    /// @param location The source location of the part missing the modifier.
    /// @param modifier The modifier spelling (`data`, `inline`, or `ref`).
    /// @param name The type name.
    func ReportPartialModifierMustMatchAllParts(location TextLocation, modifier string, name string) -> Report(
        location,
        DiagnosticDescriptors.PartialModifierMustMatchAllParts,
        modifier,
        name
    )

    /// ADR-0144 / issue #2201: GS0480 — the parts of a partial type declare
    /// differing type-parameter lists (names, arity, order, or constraints).
    /// @param location The source location of the mismatched declaration's identifier.
    /// @param name The type name.
    func ReportPartialTypeParameterMismatch(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.PartialTypeParameterMismatch,
        name
    )

    /// ADR-0144 / issue #2201: GS0481 — the parts of a partial type have
    /// conflicting base clauses (differing base class, or base-constructor
    /// arguments on more than one part).
    /// @param location The source location of the conflicting declaration's identifier.
    /// @param name The type name.
    func ReportPartialBaseClauseConflict(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.PartialBaseClauseConflict,
        name
    )

    /// ADR-0144 / issue #2201: GS0482 — more than one part of a partial type
    /// declares a primary constructor.
    /// @param location The source location of the offending declaration's identifier.
    /// @param name The type name.
    func ReportPartialMultiplePrimaryConstructors(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.PartialMultiplePrimaryConstructors,
        name
    )

    /// ADR-0144 / issue #2201: GS0483 — more than one part of a partial type
    /// declares a `deinit`.
    /// @param location The source location of the offending `deinit`.
    /// @param name The type name.
    func ReportPartialMultipleDeinit(location TextLocation, name string) -> Report(
        location,
        DiagnosticDescriptors.PartialMultipleDeinit,
        name
    )

    /// Issue #987: GS0387 — a concrete (non-`open`) class derives from an
    /// abstract base but does not override every inherited abstract method. The
    /// class must either override the member or be declared `open` (and so
    /// remain abstract itself). Mirrors C#'s CS0534.
    /// @param location The source location of the offending class identifier.
    /// @param className The concrete class that fails to implement the member.
    /// @param declaringTypeName The type that declares the abstract member.
    /// @param memberName The abstract member's name.
    func ReportAbstractMemberNotImplemented(
        location TextLocation,
        className string,
        declaringTypeName string,
        memberName string
    ) -> Report(location, DiagnosticDescriptors.AbstractMemberNotImplemented, className, declaringTypeName, memberName)

    /// ADR-0195 / issue #4674: GS0617 — a `shared` class declares something it
    /// cannot hold. Every member of a shared class is shared and the class is
    /// emitted `abstract sealed`, so an `init(…)` constructor, a
    /// primary constructor, a `deinit` and a nested `shared { }` block
    /// are rejected.
    /// @param location The source location of the offending declaration.
    /// @param className The shared class name.
    /// @param what What the class declared (for example "a primary constructor").
    func ReportSharedClassCannotDeclare(location TextLocation, className string, what string) -> Report(
        location,
        DiagnosticDescriptors.SharedClassCannotDeclare,
        className,
        what
    )

    /// ADR-0195 / issue #4674: GS0618 — `shared` is combined with another
    /// class modifier (`open`, `sealed`, `abstract` or
    /// `data`) that contradicts a class which is neither inheritable nor
    /// instantiable.
    /// @param location The source location of the conflicting modifier.
    /// @param modifier The conflicting modifier's text.
    func ReportSharedClassModifierConflict(location TextLocation, modifier string) -> Report(
        location,
        DiagnosticDescriptors.SharedClassModifierConflict,
        modifier
    )

    /// ADR-0195 / issue #4674: GS0619 — a `shared` class lists a base class
    /// or an interface.
    /// @param location The source location of the base-type clause.
    /// @param className The shared class name.
    func ReportSharedClassCannotHaveBaseTypes(location TextLocation, className string) -> Report(
        location,
        DiagnosticDescriptors.SharedClassCannotHaveBaseTypes,
        className
    )

    /// Issue #987: GS0388 — a no-body method (an abstract member) appears where
    /// it is not permitted. An abstract method must be declared `open` and
    /// may only live inside an `open class`. Mirrors C#'s CS0513/CS0500.
    /// @param location The source location of the offending method identifier.
    /// @param methodName The bodyless method's name.
    /// @param className The enclosing class name.
    func ReportAbstractMethodRequiresOpenClass(location TextLocation, methodName string, className string) -> Report(
        location,
        DiagnosticDescriptors.AbstractMethodRequiresOpenClass,
        methodName,
        className
    )

    /// Reports an invalid explicit abstract property declaration.
    /// @param location The declaration location.
    /// @param propertyName The property name.
    func ReportInvalidAbstractProperty(location TextLocation, propertyName string) -> Report(
        location,
        DiagnosticDescriptors.InvalidAbstractProperty,
        propertyName
    )

    /// Reports an unreadable replacement for a positional data property.
    /// @param location The property identifier location.
    /// @param propertyName The positional property name.
    func ReportPositionalPropertyReplacementRequiresGetter(location TextLocation, propertyName string) -> Report(
        location,
        DiagnosticDescriptors.PositionalPropertyReplacementRequiresGetter,
        propertyName
    )

    /// Reports a positional constructor argument after a composite literal element.
    /// @param location The positional member location.
    /// @param memberName The positional member name.
    func ReportPositionalInitializerAfterCompositeElement(location TextLocation, memberName string) -> Report(
        location,
        DiagnosticDescriptors.PositionalInitializerAfterCompositeElement,
        memberName
    )

    /// Reports GS0370 — ADR-0118 / issue #944: an indexer member
    /// (`prop this[…] T { … }`) was declared with no index parameters.
    /// An indexer must declare at least one parameter.
    /// @param location The source location of the indexer declaration.
    func ReportIndexerRequiresParameter(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.IndexerRequiresParameter
    )

    /// Reports GS0371 — ADR-0118 / issue #944: an indexer member
    /// (`prop this[…] T`) was declared without an accessor body. An
    /// indexer must declare a `get` and/or `set` accessor with a
    /// body; there is no auto-indexer form.
    /// @param location The source location of the indexer declaration.
    func ReportIndexerRequiresAccessorBody(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.IndexerRequiresAccessorBody
    )

    /// Reports GS0578 — issue #3879 (ADR-0060 amendment): a `ref`-returning
    /// property or indexer was declared without a bodied getter (an
    /// auto-property, a bare `{ get }`, or an abstract/interface slot).
    /// A by-ref return has to name the storage it aliases, and only a computed
    /// getter can do that.
    /// @param location The source location of the property declaration.
    /// @param propertyName The property name (or `this[…]` for an indexer).
    func ReportRefPropertyRequiresComputedGetter(location TextLocation, propertyName string) -> Report(
        location,
        DiagnosticDescriptors.RefPropertyRequiresComputedGetter,
        propertyName
    )

    /// Reports GS0579 — issue #3879 (ADR-0060 amendment): a `ref`-returning
    /// property or indexer declared a `set` or `init` accessor. The
    /// returned reference IS the write path, so a setter would be a second,
    /// contradictory one (C# spells the same rule CS8147).
    /// @param location The source location of the offending accessor.
    /// @param propertyName The property name (or `this[…]` for an indexer).
    /// @param accessorKeyword The offending accessor keyword — `set` or `init`.
    func ReportRefPropertyCannotHaveSetter(
        location TextLocation,
        propertyName string,
        accessorKeyword string
    ) -> Report(location, DiagnosticDescriptors.RefPropertyCannotHaveSetter, propertyName, accessorKeyword)

    /// Issue #1017: GS0393 — a user-defined conversion operator
    /// (`func operator implicit/explicit (x T) U`) must declare exactly one
    /// parameter (the source operand) passed by value.
    /// @param location The source location of the operator name.
    /// @param isExplicit Whether the operator is `explicit`.
    func ReportConversionOperatorRequiresSingleParameter(location TextLocation, isExplicit bool) {
        let kind = if isExplicit {
            "explicit"
        } else {
            "implicit"
        }
        Report(location, DiagnosticDescriptors.ConversionOperatorRequiresSingleParameter, kind)
    }

    /// Issue #1017: GS0394 — a user-defined conversion operator must convert to
    /// or from the enclosing user type, and source and target must differ
    /// (mirrors C# CS0555/CS0556).
    /// @param location The source location of the operator name.
    func ReportConversionOperatorMustInvolveEnclosingType(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.ConversionOperatorMustInvolveEnclosingType
    )

    /// Issue #1017: GS0395 — two user-defined conversion operators on the same
    /// type convert between the same source/target pair (mirrors C# CS0557).
    /// @param location The source location of the operator name.
    /// @param sourceType The conversion source type.
    /// @param targetType The conversion target type.
    func ReportDuplicateConversionOperator(
        location TextLocation,
        sourceType TypeSymbol,
        targetType TypeSymbol
    ) -> Report(location, DiagnosticDescriptors.DuplicateConversionOperator, sourceType, targetType)

    /// Reports GS0537 when an operator declares method type parameters.
    /// @param location The generic parameter list location.
    /// @param operatorName The CLR operator name.
    func ReportGenericOperatorNotSupported(location TextLocation, operatorName string) -> Report(
        location,
        DiagnosticDescriptors.GenericOperatorNotSupported,
        operatorName
    )

    /// ADR-0149: GS0492 — an explicit-interface qualifier clause
    /// (`func (X) M(...)` / `prop (X) P T` / `event (X) E T`)
    /// referenced a type that is not an interface.
    /// @param location The source location of the clause's type reference.
    /// @param typeName The display name of the non-interface type.
    /// @param memberName The declared member name.
    func ReportExplicitInterfaceClauseTypeNotInterface(
        location TextLocation,
        typeName string,
        memberName string
    ) -> Report(location, DiagnosticDescriptors.ExplicitInterfaceClauseTypeNotInterface, typeName, memberName)

    /// ADR-0149: GS0493 — an explicit-interface qualifier clause referenced an
    /// interface the containing type does not implement.
    /// @param location The source location of the clause's type reference.
    /// @param containingTypeName The containing class/struct name.
    /// @param interfaceName The referenced interface's name.
    /// @param memberName The declared member name.
    func ReportExplicitInterfaceClauseNotImplemented(
        location TextLocation,
        containingTypeName string,
        interfaceName string,
        memberName string
    ) -> Report(
        location,
        DiagnosticDescriptors.ExplicitInterfaceClauseNotImplemented,
        containingTypeName,
        interfaceName,
        memberName
    )

    /// ADR-0149: GS0494 — an explicit-interface qualifier clause's interface
    /// is implemented, but no member on it matches the declared name,
    /// signature, or accessor shape.
    /// @param location The source location of the declared member.
    /// @param interfaceName The referenced interface's name.
    /// @param memberName The declared member name.
    func ReportExplicitInterfaceClauseMemberNotFound(
        location TextLocation,
        interfaceName string,
        memberName string
    ) -> Report(location, DiagnosticDescriptors.ExplicitInterfaceClauseMemberNotFound, interfaceName, memberName)

    /// ADR-0149: GS0495 — two members of the same containing type both carry
    /// an explicit-interface qualifier clause that resolves to the same
    /// interface member.
    /// @param location The source location of the second (duplicate) declaration.
    /// @param interfaceName The shared target interface's name.
    /// @param memberName The shared target member name.
    func ReportDuplicateExplicitInterfaceImplementation(
        location TextLocation,
        interfaceName string,
        memberName string
    ) -> Report(location, DiagnosticDescriptors.DuplicateExplicitInterfaceImplementation, interfaceName, memberName)

    /// Issue #2927: reports a nullable sequence element whose type parameter
    /// has no value/reference representation constraint.
    /// @param location The nullable sequence element type.
    /// @param typeParameterName The unconstrained type parameter.
    func ReportUnconstrainedNullableSequenceElement(location TextLocation, typeParameterName string) -> Report(
        location,
        DiagnosticDescriptors.UnconstrainedNullableSequenceElement,
        typeParameterName
    )

    /// Issue #2875: reports a setter-kind mismatch between an interface
    /// property and its implementation.
    /// @param location The implementing type's source location.
    /// @param typeName The implementing type.
    /// @param memberKind The implementation kind, such as positional member or init-only property.
    /// @param memberName The implementing member.
    /// @param interfaceName The required interface.
    /// @param propertyName The required interface property.
    /// @param implementationAccessor The implementation accessor kind.
    /// @param requiredAccessor The interface accessor kind.
    /// @param fix The corrective action.
    func ReportInterfacePropertySetterKindMismatch(
        location TextLocation,
        typeName string,
        memberKind string,
        memberName string,
        interfaceName string,
        propertyName string,
        implementationAccessor string,
        requiredAccessor string,
        fix string
    ) -> Report(
        location,
        DiagnosticDescriptors.InterfacePropertySetterKindMismatch,
        typeName,
        memberKind,
        memberName,
        interfaceName,
        propertyName,
        implementationAccessor,
        requiredAccessor,
        fix
    )

    /// Issue #2888: reports that an ordinary property has the wrong type for
    /// an interface property slot.
    /// @param location The implementing type's source location.
    /// @param typeName The implementing type.
    /// @param propertyName The implementing property.
    /// @param interfaceName The required interface.
    /// @param interfacePropertyName The required interface property.
    /// @param expectedType The interface property's substituted type.
    /// @param actualType The implementation property's type.
    func ReportInterfacePropertyTypeMismatch(
        location TextLocation,
        typeName string,
        propertyName string,
        interfaceName string,
        interfacePropertyName string,
        expectedType TypeSymbol,
        actualType TypeSymbol
    ) -> Report(
        location,
        DiagnosticDescriptors.InterfacePropertyTypeMismatch,
        typeName,
        propertyName,
        interfaceName,
        interfacePropertyName,
        expectedType,
        actualType
    )

    /// ADR-0199: reports a data class/struct `PrintMembers(StringBuilder)` whose
    /// shape cannot replace the synthesized print-members slot. Compiler-internal on
    /// purpose: it adds nothing to the public API snapshot (#4654).
    /// @param location The text location of the member name.
    /// @param typeName The data type name.
    /// @param isClass `true` when the type is a data class; otherwise a data struct.
    /// @param requiredAccessibility The accessibility the slot must have (`private` or `protected`).
    internal func ReportIncompatibleDataPrintMembers(
        location TextLocation,
        typeName string,
        isClass bool,
        requiredAccessibility string
    ) {
        Report(
            location,
            DiagnosticDescriptors.IncompatibleDataPrintMembers,
            if isClass {
                "class"
            } else {
                "struct"
            },
            typeName,
            requiredAccessibility
        )
    }

    shared {
        private func GetAggregateKindName(symbol StructSymbol) string -> if symbol.IsClass {
            "Class"
        } else {
            "Struct"
        }
    }
}
