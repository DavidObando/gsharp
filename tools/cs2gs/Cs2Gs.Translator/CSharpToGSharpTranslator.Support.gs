// <copyright file="CSharpToGSharpTranslator.Support.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import Microsoft.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        /// Carries the result of the T2 constructor-lift analysis (ADR-0115 §B.3):
        /// which immutable fields move to a primary-constructor parameter, which
        /// gain a field initializer, and whether the explicit `init`
        /// constructor can be dropped entirely.
        private class ConstructorLift {
            init() {
                PrimaryParameters = List[Parameter]()
                FieldsAsPrimaryParameters = HashSet[string]()
                PropertiesAsPrimaryParameters = HashSet[IPropertySymbol](SymbolEqualityComparer.Default)
                PropertiesAsBodyFields = HashSet[IPropertySymbol](SymbolEqualityComparer.Default)
                FieldInitializers = Dictionary[string, GExpression]()
                BodyFieldInitializers = Dictionary[IPropertySymbol, GExpression](SymbolEqualityComparer.Default)
                ResidualInitStatements = List[GStatement]()
            }

            prop Constructor ConstructorDeclarationSyntax? {
                get;
                init;
            }

            prop DropConstructor bool {
                get;
                init;
            }

            prop PrimaryParameters IReadOnlyList[Parameter] {
                get;
                init;
            }

            prop FieldsAsPrimaryParameters HashSet[string] {
                get;
                init;
            }

            /// Gets the exact property symbols consumed by primary-constructor
            /// lifting. Symbol identity is required because ordinary and explicit-
            /// interface properties may legally share a simple name.
            prop PropertiesAsPrimaryParameters HashSet[IPropertySymbol] {
                get;
                init;
            }

            /// Gets the auto-properties whose inline initializer is NOT a
            /// compile-time constant (issue #2281) and so cannot become a
            /// primary-constructor parameter default (G# optional-parameter
            /// defaults must be constants, GS0265). Such a property is
            /// instead lifted to a plain body `let` field carrying the
            /// initializer verbatim — the field initializer runs from the
            /// data class's always-emitted parameterless constructor
            /// (mirroring the C# record's own per-instance initializer
            /// semantics), while the primary constructor's parameter list
            /// stays limited to constant-default/required members.
            prop PropertiesAsBodyFields HashSet[IPropertySymbol] {
                get;
                init;
            }

            prop FieldInitializers Dictionary[string, GExpression] {
                get;
                init;
            }

            /// Gets the initializer expressions for (cref:PropertiesAsBodyFields)
            /// (issue #2281), keyed by exact property symbol.
            prop BodyFieldInitializers Dictionary[IPropertySymbol, GExpression] {
                get;
                init;
            }

            /// Gets the constructor-body assignments that could not be hoisted to a
            /// field initializer because their right-hand side reads an instance
            /// member (GS0125). They are re-emitted, in source order, as a synthesized
            /// parameterless `init() { ... }` when the explicit constructor is
            /// otherwise dropped.
            prop ResidualInitStatements IReadOnlyList[GStatement] {
                get;
                init;
            }

            shared {
                let None ConstructorLift = ConstructorLift()
            }
        }

        private class StructConstructorPlan {
            init(
                constructor IMethodSymbol?,
                initializations IReadOnlyList[StructMemberInitialization],
                fixedInitializersAreDeclaredOnType bool
            ) {
                this.Constructor = constructor
                this.Initializations = initializations
                this.FixedInitializersAreDeclaredOnType = fixedInitializersAreDeclaredOnType
            }

            prop Constructor IMethodSymbol? {
                get;
            }

            prop Initializations IReadOnlyList[StructMemberInitialization] {
                get;
            }

            prop FixedInitializersAreDeclaredOnType bool {
                get;
            }
        }

        private class StructMemberInitialization {
            init(memberName string?, parameterOrdinal int32) {
                this.MemberName = memberName
                this.ParameterOrdinal = parameterOrdinal
            }

            init(memberName string?, fixedExpression ExpressionSyntax?) {
                this.MemberName = memberName
                this.FixedExpression = fixedExpression
            }

            prop MemberName string? {
                get;
            }

            prop ParameterOrdinal int32? {
                get;
            }

            prop FixedExpression ExpressionSyntax? {
                get;
            }
        }

        // Issue #4382: the members a positional pattern's slots read (see
        // TryGetPositionalMembers). For a tuple, `IsTuple` is set, the names
        // are `Item1`, `Item2`, ..., and `Members`/`Failures` are empty. For a
        // `Deconstruct`, `Members[i]` is the property or field slot `i` reads,
        // or null when it has no canonical member, and `Failures[i]` says why.
        // A class rather than a nullable tuple so the self-migrated G# needs
        // no tuple conversion and no nil array.
        private class PositionalSlots {
            init(isTuple bool, names[]string, members[]ISymbol, failures[]string) {
                this.IsTuple = isTuple
                this.Names = names
                this.Members = members
                this.Failures = failures
            }

            prop IsTuple bool {
                get;
            }

            prop Names[]string {
                get;
            }

            prop Members[]ISymbol {
                get;
            }

            prop Failures[]string {
                get;
            }
        }

        // Issue #1971: groups extended property subpatterns (`{ A.B: 0, A.C: 1 }`,
        // parsed as `ExpressionColon`) sharing a leftmost identifier prefix so
        // <see cref="TranslateRecursivePattern"/> can merge them into ONE nested
        // `PropertyPattern` field (`{ A: { B: 0, C: 1 } }`) instead of emitting
        // the same top-level field name twice — works to any shared-prefix depth
        // (`{ A.B.C: 0, A.B.D: 1 }` merges at `A.B` too).
        private class ExtendedPropertyFieldTree {
            // Preserves first-occurrence order of each child name at this
            // level, so the emitted field order matches the source's leftmost
            // occurrence of each shared prefix (mirrors how a hand-written
            // nested pattern would read).
            private let order List[string] = List[string]()

            private let leaves Dictionary[string, PatternSyntax] = Dictionary[string, PatternSyntax]()
            private let children Dictionary[string, ExtendedPropertyFieldTree] = Dictionary[
                string,
                ExtendedPropertyFieldTree
            ]()

            // Bug (N1, Opus review of #1971): set when a path segment is
            // targeted by BOTH a leaf value check (`A.B: 0`) and a nested
            // member check (`A.B.C: 1`) — merging those into one
            // PropertyPattern field would require silently dropping one side.
            // Propagated up from whichever depth the collision occurs at, so
            // the caller can detect it anywhere in the (sub)tree and bail out
            // of the whole merge for the offending root instead of guessing.
            prop HasCollision bool {
                get;
                private set;
            }

            prop CollisionSegment string {
                get;
                private set;
            }

            func Insert(names List[string], index int32, leafPattern PatternSyntax) {
                let name = names[index]
                if index == names.Count - 1 {
                    if this.children.ContainsKey(name) {
                        // A nested-member check for `name` was already inserted
                        // (e.g. `A.B.C: ...` seen before `A.B: ...`) — this
                        // leaf check would collide with it. Don't add it as a
                        // leaf (that would silently drop the nested subtree);
                        // record the collision instead.
                        this.HasCollision = true
                        this.CollisionSegment = name
                        return
                    }
                    if !this.leaves.ContainsKey(name) {
                        this.order.Add(name)
                    }
                    this.leaves[name] = leafPattern
                    return
                }
                if this.leaves.ContainsKey(name) {
                    // A leaf value check for `name` was already inserted (e.g.
                    // `A.B: ...` seen before `A.B.C: ...`) — this nested check
                    // would collide with it. Don't create/descend into a child
                    // (that would silently drop the leaf check); record the
                    // collision instead.
                    this.HasCollision = true
                    this.CollisionSegment = name
                    return
                }
                if !this.children.TryGetValue(name, out var child) {
                    child = ExtendedPropertyFieldTree()
                    this.children[name] = child
                    this.order.Add(name)
                }
                child.Insert(names, index + 1, leafPattern)
                if child.HasCollision {
                    this.HasCollision = true
                    this.CollisionSegment = child.CollisionSegment
                }
            }

            func ConvertChildren(
                translator DeclarationVisitor,
                parentReceiver GExpression,
                bindings List[(Symbol ISymbol, Replacement GExpression)],
                usedDesignators HashSet[string]?,
                guards List[GExpression],
                mutableBindings List[(Symbol ILocalSymbol, MatchedValue GExpression)]?
            ) List[PropertyPatternField] {
                let fields = List[PropertyPatternField]()
                for name in this.order {
                    let memberReceiver GExpression = MemberAccessExpression(parentReceiver, name)
                    if this.leaves.TryGetValue(name, out var leafPattern) {
                        fields.Add(
                            PropertyPatternField(
                                name,
                                translator.TranslatePattern(
                                    leafPattern,
                                    memberReceiver,
                                    bindings,
                                    usedDesignators,
                                    guards,
                                    mutableBindings
                                )
                            )
                        )
                        continue
                    }
                    let child = this.children[name]
                    let childFields = child.ConvertChildren(
                        translator,
                        memberReceiver,
                        bindings,
                        usedDesignators,
                        guards,
                        mutableBindings
                    )
                    fields.Add(PropertyPatternField(name, PropertyPattern(childFields)))
                }
                return fields
            }

            func ConvertNativeChildren(translator DeclarationVisitor, binders List[ILocalSymbol]) List[
                PropertyPatternField
            ] {
                let fields = List[PropertyPatternField]()
                for name in this.order {
                    if this.leaves.TryGetValue(name, out var leafPattern) {
                        fields.Add(PropertyPatternField(name, translator.BuildNativePattern(leafPattern, binders)))
                        continue
                    }
                    let child = this.children[name]
                    fields.Add(
                        PropertyPatternField(name, PropertyPattern(child.ConvertNativeChildren(translator, binders)))
                    )
                }
                return fields
            }
        }
    }
}
