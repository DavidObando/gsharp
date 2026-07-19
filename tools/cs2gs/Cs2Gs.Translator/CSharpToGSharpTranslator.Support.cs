// <copyright file="CSharpToGSharpTranslator.Support.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Text;

namespace Cs2Gs.Translator;

public sealed partial class CSharpToGSharpTranslator
{
    private sealed partial class DeclarationVisitor
    {
        /// <summary>
        /// Carries the result of the T2 constructor-lift analysis (ADR-0115 §B.3):
        /// which immutable fields move to a primary-constructor parameter, which
        /// gain a field initializer, and whether the explicit <c>init</c>
        /// constructor can be dropped entirely.
        /// </summary>
        private sealed class ConstructorLift
        {
            public static readonly ConstructorLift None = new ConstructorLift();

            public ConstructorDeclarationSyntax Constructor { get; init; }

            public bool DropConstructor { get; init; }

            public IReadOnlyList<Parameter> PrimaryParameters { get; init; } = new List<Parameter>();

            public HashSet<string> FieldsAsPrimaryParameters { get; init; } = new HashSet<string>();

            public HashSet<string> PropertiesAsPrimaryParameters { get; init; } = new HashSet<string>();

            /// <summary>
            /// Gets the auto-properties whose inline initializer is NOT a
            /// compile-time constant (issue #2281) and so cannot become a
            /// primary-constructor parameter default (G# optional-parameter
            /// defaults must be constants, GS0265). Such a property is
            /// instead lifted to a plain body <c>let</c> field carrying the
            /// initializer verbatim — the field initializer runs from the
            /// data class's always-emitted parameterless constructor
            /// (mirroring the C# record's own per-instance initializer
            /// semantics), while the primary constructor's parameter list
            /// stays limited to constant-default/required members.
            /// </summary>
            public HashSet<string> PropertiesAsBodyFields { get; init; } = new HashSet<string>();

            public Dictionary<string, GExpression> FieldInitializers { get; init; } =
                new Dictionary<string, GExpression>();

            /// <summary>
            /// Gets the initializer expressions for <see cref="PropertiesAsBodyFields"/>
            /// (issue #2281), keyed by property name.
            /// </summary>
            public Dictionary<string, GExpression> BodyFieldInitializers { get; init; } =
                new Dictionary<string, GExpression>();

            /// <summary>
            /// Gets the constructor-body assignments that could not be hoisted to a
            /// field initializer because their right-hand side reads an instance
            /// member (GS0125). They are re-emitted, in source order, as a synthesized
            /// parameterless <c>init() { ... }</c> when the explicit constructor is
            /// otherwise dropped.
            /// </summary>
            public IReadOnlyList<GStatement> ResidualInitStatements { get; init; } =
                new List<GStatement>();
        }

        private sealed class StructConstructorPlan
        {
            public StructConstructorPlan(
                IMethodSymbol constructor,
                IReadOnlyList<StructMemberInitialization> initializations,
                bool fixedInitializersAreDeclaredOnType)
            {
                this.Constructor = constructor;
                this.Initializations = initializations;
                this.FixedInitializersAreDeclaredOnType = fixedInitializersAreDeclaredOnType;
            }

            public IMethodSymbol Constructor { get; }

            public IReadOnlyList<StructMemberInitialization> Initializations { get; }

            public bool FixedInitializersAreDeclaredOnType { get; }
        }

        private sealed class StructMemberInitialization
        {
            public StructMemberInitialization(string memberName, int parameterOrdinal)
            {
                this.MemberName = memberName;
                this.ParameterOrdinal = parameterOrdinal;
            }

            public StructMemberInitialization(string memberName, ExpressionSyntax fixedExpression)
            {
                this.MemberName = memberName;
                this.FixedExpression = fixedExpression;
            }

            public string MemberName { get; }

            public int? ParameterOrdinal { get; }

            public ExpressionSyntax FixedExpression { get; }
        }

        // Issue #1971: groups extended property subpatterns (`{ A.B: 0, A.C: 1 }`,
        // parsed as `ExpressionColon`) sharing a leftmost identifier prefix so
        // <see cref="TranslateRecursivePattern"/> can merge them into ONE nested
        // `PropertyPattern` field (`{ A: { B: 0, C: 1 } }`) instead of emitting
        // the same top-level field name twice — works to any shared-prefix depth
        // (`{ A.B.C: 0, A.B.D: 1 }` merges at `A.B` too).
        private sealed class ExtendedPropertyFieldTree
        {
            // Preserves first-occurrence order of each child name at this
            // level, so the emitted field order matches the source's leftmost
            // occurrence of each shared prefix (mirrors how a hand-written
            // nested pattern would read).
            private readonly List<string> order = new List<string>();
            private readonly Dictionary<string, PatternSyntax> leaves = new Dictionary<string, PatternSyntax>();
            private readonly Dictionary<string, ExtendedPropertyFieldTree> children = new Dictionary<string, ExtendedPropertyFieldTree>();

            // Bug (N1, Opus review of #1971): set when a path segment is
            // targeted by BOTH a leaf value check (`A.B: 0`) and a nested
            // member check (`A.B.C: 1`) — merging those into one
            // PropertyPattern field would require silently dropping one side.
            // Propagated up from whichever depth the collision occurs at, so
            // the caller can detect it anywhere in the (sub)tree and bail out
            // of the whole merge for the offending root instead of guessing.
            public bool HasCollision { get; private set; }

            public string CollisionSegment { get; private set; }

            public void Insert(List<string> names, int index, PatternSyntax leafPattern)
            {
                string name = names[index];
                if (index == names.Count - 1)
                {
                    if (this.children.ContainsKey(name))
                    {
                        // A nested-member check for `name` was already inserted
                        // (e.g. `A.B.C: ...` seen before `A.B: ...`) — this
                        // leaf check would collide with it. Don't add it as a
                        // leaf (that would silently drop the nested subtree);
                        // record the collision instead.
                        this.HasCollision = true;
                        this.CollisionSegment = name;
                        return;
                    }

                    if (!this.leaves.ContainsKey(name))
                    {
                        this.order.Add(name);
                    }

                    this.leaves[name] = leafPattern;
                    return;
                }

                if (this.leaves.ContainsKey(name))
                {
                    // A leaf value check for `name` was already inserted (e.g.
                    // `A.B: ...` seen before `A.B.C: ...`) — this nested check
                    // would collide with it. Don't create/descend into a child
                    // (that would silently drop the leaf check); record the
                    // collision instead.
                    this.HasCollision = true;
                    this.CollisionSegment = name;
                    return;
                }

                if (!this.children.TryGetValue(name, out ExtendedPropertyFieldTree child))
                {
                    child = new ExtendedPropertyFieldTree();
                    this.children[name] = child;
                    this.order.Add(name);
                }

                child.Insert(names, index + 1, leafPattern);
                if (child.HasCollision)
                {
                    this.HasCollision = true;
                    this.CollisionSegment = child.CollisionSegment;
                }
            }

            public List<PropertyPatternField> ConvertChildren(
                DeclarationVisitor translator,
                GExpression parentReceiver,
                List<(ISymbol Symbol, GExpression Replacement)> bindings,
                HashSet<string> usedDesignators,
                List<GExpression> guards)
            {
                var fields = new List<PropertyPatternField>();
                foreach (string name in this.order)
                {
                    GExpression memberReceiver = new MemberAccessExpression(parentReceiver, name);
                    if (this.leaves.TryGetValue(name, out PatternSyntax leafPattern))
                    {
                        fields.Add(new PropertyPatternField(
                            name,
                            translator.TranslatePattern(leafPattern, memberReceiver, bindings, usedDesignators, guards)));
                        continue;
                    }

                    ExtendedPropertyFieldTree child = this.children[name];
                    List<PropertyPatternField> childFields = child.ConvertChildren(translator, memberReceiver, bindings, usedDesignators, guards);
                    fields.Add(new PropertyPatternField(name, new PropertyPattern(childFields)));
                }

                return fields;
            }
        }
    }
}
