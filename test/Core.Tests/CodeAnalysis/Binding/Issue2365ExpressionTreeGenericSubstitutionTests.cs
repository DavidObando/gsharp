// <copyright file="Issue2365ExpressionTreeGenericSubstitutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2365: an imported generic method whose delegate/expression-tree parameter closes over
/// the DECLARING TYPE's own type parameter via a symbolic receiver (e.g. EF Core's
/// <c>CreateTableBuilder&lt;TColumns&gt;.PrimaryKey(string, Expression&lt;Func&lt;TColumns,object&gt;&gt;)</c>)
/// erased the lambda's target type all the way down to <c>Expression&lt;Func&lt;object,object&gt;&gt;</c>,
/// producing an unverifiable assembly (ILVerify <c>StackUnexpected</c>: found
/// <c>Expression&lt;Func&lt;object,object&gt;&gt;</c>, expected
/// <c>Expression&lt;Func&lt;TColumns,object&gt;&gt;</c>) even though binding itself reported no error.
///
/// Root cause (two compounding, EF-agnostic defects, both fixed):
/// <list type="number">
/// <item><description>
/// <c>ExpressionBinder.Calls.TryBuildSymbolicDelegateTargetForMethodParam</c> (used to rebind a lambda
/// LITERAL's own function type before it is checked against a parameter) only recovered a symbolic
/// delegate target when the METHOD ITSELF was generic (issue #1512's
/// <c>Task.ContinueWith&lt;TResult&gt;</c> shape). A NON-generic method whose delegate parameter mentions
/// the DECLARING TYPE's type parameter through a symbolic RECEIVER (our case) fell through untouched.
/// It also never unwrapped an <c>Expression&lt;TDelegate&gt;</c> parameter (which has no <c>Invoke</c>
/// method) before probing for one, so even the ALREADY-supported method-generic case would have failed
/// for an <c>Expression&lt;&gt;</c>-wrapped parameter.
/// </description></item>
/// <item><description>
/// <c>ConversionClassifier.TrySubstituteParameterTypeFromReceiver</c> (used for the actual
/// argument-to-parameter CONVERSION, downstream of and independent from the lambda-literal rebind above)
/// only substituted a parameter type that WAS DIRECTLY the receiver's generic parameter slot, with no
/// recursion into nested constructed generics such as <c>Expression&lt;Func&lt;TColumns,object&gt;&gt;</c>.
/// Its sibling, <c>TrySubstituteParameterTypeFromMethodTypeArgs</c> (the method-type-argument
/// equivalent), had already been generalized to the fully recursive
/// <c>MemberLookup.MapOpenClrTypeToSymbolic</c> — the receiver-level sibling was simply never updated to
/// match, so even after (1) recovered the correct symbolic delegate shape for the lambda LITERAL, the
/// subsequent conversion of that literal to the declared <c>Expression&lt;Func&lt;TColumns,object&gt;&gt;</c>
/// parameter type re-erased it back down to the CLR-closed, type-argument-less shape.
/// </description></item>
/// </list>
/// Both fixes reuse the existing, EF-agnostic <c>MemberLookup.MapOpenClrTypeToSymbolic</c> substitution
/// engine (already used by every other staged/deferred lambda and generic-substitution path in the
/// binder) — there is no anonymous-type or EF-specific special case anywhere in the fix.
/// </summary>
public class Issue2365ExpressionTreeGenericSubstitutionTests
{
    [Fact]
    public void ImportedInstanceMethod_ExpressionParameterClosedOverReceiverTypeArgument_Binds()
    {
        // The exact reported shape: PrimaryKey is a NON-generic instance method on
        // CreateTableBuilder[TColumns]; its Expression[Func[TColumns,object]] parameter closes purely
        // through the symbolic RECEIVER (the `table` parameter's own declared type), not through any
        // method-level type argument.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.PrimaryKey("PK_Accounts", (x Cols) -> x.Id)
                })
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void ImportedInstanceMethod_StructTypeArgument_Binds()
    {
        // Value-type (struct) TColumns control: the substitution must also work when the closed-over
        // type is a data struct, not just a reference type.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data struct StructCols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> StructCols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[StructCols]) -> {
                    table.PrimaryKey("PK_Accounts", (x StructCols) -> x.Id)
                })
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void ImportedInstanceMethod_ExplicitOuterTypeArguments_Binds()
    {
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable[Cols]("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.PrimaryKey("PK_Accounts", (x Cols) -> x.Id)
                })
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void ImportedInstanceMethod_MultipleLambdaParameters_Binds()
    {
        // Parameter-SHAPE coverage: the Expression's own delegate has TWO parameters of TColumns
        // (Func[TColumns, TColumns, object]), not just one.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.PrimaryKeyComposite("PK_Accounts", (a Cols, b Cols) -> a.Id)
                })
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void ImportedInstanceMethod_ExpressionParameterNotInFirstPosition_Binds()
    {
        // Parameter-POSITION coverage: the Expression[] argument is the SECOND of three parameters,
        // not the delegate-target-establishing first one.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.IndexOn(true, (x Cols) -> x.Id, "IX_Accounts")
                })
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void ImportedInstanceMethod_DirectActionShape_NotWrappedInExpression_Binds()
    {
        // Confirms the receiver-symbolic generalization (defect 1's gate fix) applies to a plain
        // Action[TColumns] delegate too, not only Expression[Func[TColumns,object]] shapes.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.ForEachColumn((x Cols) -> { })
                })
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void ImportedInstanceMethod_NestedGenericComposition_Binds()
    {
        // TColumns appears nested inside another constructed generic
        // (Expression[Func[Wrapper[TColumns], object]]), exercising the recursive substitution path in
        // MemberLookup.MapOpenClrTypeToSymbolic beyond a single top-level type-parameter slot.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.NestedSelector((w Wrapper[Cols]) -> w)
                })
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void ImportedGenericConstructor_ExplicitTypeArgumentWithExpressionParameter_Binds()
    {
        // Sibling code path (issue #1502's constructor-lambda recovery, generalized by #2365):
        // an imported generic type's CONSTRUCTOR takes an Expression[]-wrapped parameter closing over
        // the type's own type argument, exercising ExpressionBinder.Calls.TryBuildSymbolicDelegateTarget
        // / TryResolveSymbolicDelegateTargetForCtor, which had the identical missing Expression[] unwrap
        // as defect 1's method-parameter sibling.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run() {
                var holder = ExpressionHolder[Cols]((c Cols) -> c.Id)
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void SourceOnlyGenericMethod_ExpressionParameterClosedOverReceiverTypeArgument_AlreadyBinds()
    {
        // Control: a PURELY source-declared (non-imported) generic class with an Expression[]-shaped
        // method closing over its own type parameter through a symbolic receiver, entirely inside the
        // CONSUMER source (no CLR reflection / ImportedTypeSymbol involved at all). This exercises a
        // different (purely symbolic) substitution path and is expected to already work; it guards
        // against a regression in that path from the imported-method-focused fix above.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib
            import System
            import System.Linq.Expressions

            data class Cols(Id string)

            class LocalBox[T] {
                func Select(selector Expression[Func[T, object]]) Expression[Func[T, object]] { return selector }
            }

            func Run() {
                var box = LocalBox[Cols]{}
                var expr = box.Select((c Cols) -> c.Id)
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void Issue2224Followup_ImportedGenericExpressionTree_ClosesOverNamedClass_Binds()
    {
        // Issue #2224 follow-up: the original #2224 regression validated that an anonymous-class
        // literal used INSIDE an expression tree lowers with correct PropertyInfo `NewExpression.Members`
        // (see Issue2224AnonymousClassExpressionTreeMembersTests, unmodified and still passing). This is
        // the #2365-specific follow-up: the SAME kind of class-shaped value, when it is the TColumns of
        // an IMPORTED generic method's Expression[Func[TColumns,object]] parameter (rather than a
        // directly-annotated source parameter type), must likewise preserve the real class shape all the
        // way through — not erase to `object` — so that member/property recognition downstream (e.g. an
        // EF-style reflection-based key-shape reader) keeps working. See also the runtime-level
        // regression coverage in Issue2365ExpressionTreeGenericSubstitutionEmitTests.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string, Name string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id"), Name: table.Column("name")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.PrimaryKey("PK_Accounts", (x Cols) -> x.Id)
                    table.Annotation("Sqlite:Autoincrement", true)
                })
            }
            """);

        AssertBindsCleanly(result);
    }

    [Fact]
    public void NegativeControl_ArityMismatchOnExpressionParameter_StillFailsWithDiagnostic()
    {
        // The Expression parameter's own delegate declares zero lambda parameters where the
        // receiver-closed shape requires exactly one — the generalized substitution must not silently
        // accept an incompatible lambda shape.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.PrimaryKey("PK_Accounts", () -> "unrelated")
                })
            }
            """,
            expectSuccess: false);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void NegativeControl_UnknownMemberOnReceiverStillFailsWithDiagnostic()
    {
        // Sanity control: an unrelated/nonexistent member call on the same symbolic receiver must not
        // be swallowed by the generalized substitution recovery — it should still fail to resolve.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.NoSuchMethod("PK_Accounts", (x Cols) -> x.Id)
                })
            }
            """,
            expectSuccess: false);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void NegativeControl_ArityMismatchOnCompositeExpressionParameter_StillFailsWithDiagnostic()
    {
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.PrimaryKeyComposite("PK_Accounts", (a Cols) -> a.Id)
                })
            }
            """,
            expectSuccess: false);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void AmbiguityControl_OverloadedByArityStillRanksToExactMatch()
    {
        // Overload-ranking coverage: PrimaryKey and PrimaryKeyWithUnique share the same receiver-closed
        // Expression[Func[TColumns,object]] SHAPE but differ in arity/extra leading parameter; the
        // generalized substitution must not cause the wrong overload (or an ambiguous result) to be
        // picked for either call.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.PrimaryKey("PK_Accounts", (x Cols) -> x.Id)
                    table.PrimaryKeyWithUnique("PK_Accounts2", true, (x Cols) -> x.Id)
                })
            }
            """);

        AssertBindsCleanly(result);
    }

    /// <summary>
    /// Synthetic reconstruction of the reported Oahu.Data migration regression: a generic
    /// <c>CreateTable&lt;TColumns&gt;(name, columns, schema, constraints)</c> call whose constraints
    /// lambda invokes BOTH the fluent, self-returning <c>Annotation</c> call (issue #2345's shape) AND
    /// the expression-tree-parameter <c>PrimaryKey</c> call (issue #2365's shape) together, matching the
    /// real-world file's combined usage.
    /// </summary>
    [Fact]
    public void OahuDataStyleMigrationRegression_AnnotationAndPrimaryKeyTogether_Binds()
    {
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string, Name string)

            func Up(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable(
                    "Accounts",
                    (table ColumnsBuilder) -> Cols{
                        Id: table.Column("id"),
                        Name: table.Column("name"),
                    },
                    "dbo",
                    (table CreateTableBuilder[Cols]) -> {
                        table.Annotation("Sqlite:Autoincrement", true)
                        table.PrimaryKey("PK_Accounts", (x Cols) -> x.Id)
                    })
            }
            """);

        AssertBindsCleanly(result);
    }

    private static void AssertBindsCleanly(EmitResult result)
    {
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0159");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static EmitResult CompileAgainstLibrary(string consumerSource, bool expectSuccess = true)
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2365");
        Directory.CreateDirectory(outputDir);

        var libraryPath = Path.Combine(outputDir, "Issue2365.Library.dll");
        EmitLibraryAssembly(libraryPath);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });

        var consumer = new Compilation(resolver, SyntaxTree.Parse(SourceText.From(consumerSource)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2365.Consumer." + Guid.NewGuid().ToString("N"));

        _ = expectSuccess;
        return result;
    }

    private static void EmitLibraryAssembly(string libraryPath)
    {
        if (File.Exists(libraryPath))
        {
            // Reused across [Fact]s in this class; each test compiles a distinct consumer assembly
            // against the same cached library, mirroring Issue2142's / Issue2345's pattern.
            return;
        }

        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package Lib
                import System
                import System.Linq.Expressions

                class ColumnsBuilder {
                    func Column(name string) string { return name }
                }

                class Wrapper[T] {
                }

                class CreateTableBuilder[TColumns] {
                    func Annotation(name string, value object) CreateTableBuilder[TColumns] { return CreateTableBuilder[TColumns]{} }

                    func PrimaryKey(name string, columns Expression[Func[TColumns, object]]) CreateTableBuilder[TColumns] { return CreateTableBuilder[TColumns]{} }

                    func PrimaryKeyWithUnique(name string, isUnique bool, columns Expression[Func[TColumns, object]]) CreateTableBuilder[TColumns] { return CreateTableBuilder[TColumns]{} }

                    func PrimaryKeyComposite(name string, columns Expression[Func[TColumns, TColumns, object]]) CreateTableBuilder[TColumns] { return CreateTableBuilder[TColumns]{} }

                    func IndexOn(isUnique bool, columns Expression[Func[TColumns, object]], name string) CreateTableBuilder[TColumns] { return CreateTableBuilder[TColumns]{} }

                    func ForEachColumn(visit Action[TColumns]) CreateTableBuilder[TColumns] { return CreateTableBuilder[TColumns]{} }

                    func NestedSelector(columns Expression[Func[Wrapper[TColumns], object]]) CreateTableBuilder[TColumns] { return CreateTableBuilder[TColumns]{} }
                }

                class MigrationBuilder {
                    func CreateTable[TColumns](name string, columns Func[ColumnsBuilder, TColumns], schema string, constraints Action[CreateTableBuilder[TColumns]]) TColumns {
                        return columns(ColumnsBuilder{})
                    }

                    func CreateTable[TColumns](name string, columns Func[ColumnsBuilder, TColumns]) TColumns {
                        return columns(ColumnsBuilder{})
                    }
                }

                class ExpressionHolder[T] {
                    var Value Expression[Func[T, object]]
                    init(value Expression[Func[T, object]]) { Value = value }
                }
                """)))
        {
            IsLibrary = true,
        };

        using var peStream = File.Create(libraryPath);
        var result = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2365.Library");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }
}
