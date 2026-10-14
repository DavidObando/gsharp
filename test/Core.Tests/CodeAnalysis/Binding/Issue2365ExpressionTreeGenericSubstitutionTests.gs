// <copyright file="Issue2365ExpressionTreeGenericSubstitutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import Xunit

/// Issue #2365: an imported generic method whose delegate/expression-tree parameter closes over
/// the DECLARING TYPE's own type parameter via a symbolic receiver (e.g. EF Core's
/// `CreateTableBuilder<TColumns>.PrimaryKey(string, Expression<Func<TColumns,object>>)`)
/// erased the lambda's target type all the way down to `Expression<Func<object,object>>`,
/// producing an unverifiable assembly (ILVerify `StackUnexpected`: found
/// `Expression<Func<object,object>>`, expected
/// `Expression<Func<TColumns,object>>`) even though binding itself reported no error.
///
/// Root cause (two compounding, EF-agnostic defects, both fixed):
/// 1. `ExpressionBinder.Calls.TryBuildSymbolicDelegateTargetForMethodParam` (used to rebind a lambda
/// LITERAL's own function type before it is checked against a parameter) only recovered a symbolic
/// delegate target when the METHOD ITSELF was generic (issue #1512's `Task.ContinueWith<TResult>`
/// shape). A NON-generic method whose delegate parameter mentions the DECLARING TYPE's type parameter
/// through a symbolic RECEIVER (our case) fell through untouched. It also never unwrapped an
/// `Expression<TDelegate>` parameter (which has no `Invoke` method) before probing for one, so even the
/// ALREADY-supported method-generic case would have failed for an `Expression<>`-wrapped parameter.
/// 2. `ConversionClassifier.TrySubstituteParameterTypeFromReceiver` (used for the actual
/// argument-to-parameter CONVERSION, downstream of and independent from the lambda-literal rebind
/// above) only substituted a parameter type that WAS DIRECTLY the receiver's generic parameter slot,
/// with no recursion into nested constructed generics such as `Expression<Func<TColumns,object>>`. Its
/// sibling, `TrySubstituteParameterTypeFromMethodTypeArgs` (the method-type-argument equivalent), had
/// already been generalized to the fully recursive `MemberLookup.MapOpenClrTypeToSymbolic` — the
/// receiver-level sibling was simply never updated to match, so even after (1) recovered the correct
/// symbolic delegate shape for the lambda LITERAL, the subsequent conversion of that literal to the
/// declared `Expression<Func<TColumns,object>>` parameter type re-erased it back down to the
/// CLR-closed, type-argument-less shape.
/// Both fixes reuse the existing, EF-agnostic `MemberLookup.MapOpenClrTypeToSymbolic` substitution
/// engine (already used by every other staged/deferred lambda and generic-substitution path in the
/// binder) — there is no anonymous-type or EF-specific special case anywhere in the fix.
open class Issue2365ExpressionTreeGenericSubstitutionTests {
    @Fact
    func ImportedInstanceMethod_ExpressionParameterClosedOverReceiverTypeArgument_Binds() {
        // The exact reported shape: PrimaryKey is a NON-generic instance method on
        // CreateTableBuilder[TColumns]; its Expression[Func[TColumns,object]] parameter closes purely
        // through the symbolic RECEIVER (the `table` parameter's own declared type), not through any
        // method-level type argument.
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.PrimaryKey("PK_Accounts", (x Cols) -> x.Id)
    })
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func ImportedInstanceMethod_StructTypeArgument_Binds() {
        // Value-type (struct) TColumns control: the substitution must also work when the closed-over
        // type is a data struct, not just a reference type.
        let result = CompileAgainstLibrary(`package Demo
import Lib

data struct StructCols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> StructCols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[StructCols]) -> {
        table.PrimaryKey("PK_Accounts", (x StructCols) -> x.Id)
    })
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func ImportedInstanceMethod_ExplicitOuterTypeArguments_Binds() {
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable[Cols]("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.PrimaryKey("PK_Accounts", (x Cols) -> x.Id)
    })
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func ImportedInstanceMethod_MultipleLambdaParameters_Binds() {
        // Parameter-SHAPE coverage: the Expression's own delegate has TWO parameters of TColumns
        // (Func[TColumns, TColumns, object]), not just one.
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.PrimaryKeyComposite("PK_Accounts", (a Cols, b Cols) -> a.Id)
    })
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func ImportedInstanceMethod_ExpressionParameterNotInFirstPosition_Binds() {
        // Parameter-POSITION coverage: the Expression[] argument is the SECOND of three parameters,
        // not the delegate-target-establishing first one.
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.IndexOn(true, (x Cols) -> x.Id, "IX_Accounts")
    })
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func ImportedInstanceMethod_DirectActionShape_NotWrappedInExpression_Binds() {
        // Confirms the receiver-symbolic generalization (defect 1's gate fix) applies to a plain
        // Action[TColumns] delegate too, not only Expression[Func[TColumns,object]] shapes.
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.ForEachColumn((x Cols) -> { })
    })
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func ImportedInstanceMethod_NestedGenericComposition_Binds() {
        // TColumns appears nested inside another constructed generic
        // (Expression[Func[Wrapper[TColumns], object]]), exercising the recursive substitution path in
        // MemberLookup.MapOpenClrTypeToSymbolic beyond a single top-level type-parameter slot.
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.NestedSelector((w Wrapper[Cols]) -> w)
    })
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func ImportedGenericConstructor_ExplicitTypeArgumentWithExpressionParameter_Binds() {
        // Sibling code path (issue #1502's constructor-lambda recovery, generalized by #2365):
        // an imported generic type's CONSTRUCTOR takes an Expression[]-wrapped parameter closing over
        // the type's own type argument, exercising ExpressionBinder.Calls.TryBuildSymbolicDelegateTarget
        // / TryResolveSymbolicDelegateTargetForCtor, which had the identical missing Expression[] unwrap
        // as defect 1's method-parameter sibling.
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run() {
    var holder = ExpressionHolder[Cols]((c Cols) -> c.Id)
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func SourceOnlyGenericMethod_ExpressionParameterClosedOverReceiverTypeArgument_AlreadyBinds() {
        // Control: a PURELY source-declared (non-imported) generic class with an Expression[]-shaped
        // method closing over its own type parameter through a symbolic receiver, entirely inside the
        // CONSUMER source (no CLR reflection / ImportedTypeSymbol involved at all). This exercises a
        // different (purely symbolic) substitution path and is expected to already work; it guards
        // against a regression in that path from the imported-method-focused fix above.
        let result = CompileAgainstLibrary(`package Demo
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
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func Issue2224Followup_ImportedGenericExpressionTree_ClosesOverNamedClass_Binds() {
        // Issue #2224 follow-up: the original #2224 regression validated that an anonymous-class
        // literal used INSIDE an expression tree lowers with correct PropertyInfo `NewExpression.Members`
        // (see Issue2224AnonymousClassExpressionTreeMembersTests, unmodified and still passing). This is
        // the #2365-specific follow-up: the SAME kind of class-shaped value, when it is the TColumns of
        // an IMPORTED generic method's Expression[Func[TColumns,object]] parameter (rather than a
        // directly-annotated source parameter type), must likewise preserve the real class shape all the
        // way through — not erase to `object` — so that member/property recognition downstream (e.g. an
        // EF-style reflection-based key-shape reader) keeps working. See also the runtime-level
        // regression coverage in Issue2365ExpressionTreeGenericSubstitutionEmitTests.
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string, Name string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id"), Name: table.Column("name")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.PrimaryKey("PK_Accounts", (x Cols) -> x.Id)
        table.Annotation("Sqlite:Autoincrement", true)
    })
}`)
        AssertBindsCleanly(result)
    }

    @Fact
    func NegativeControl_ArityMismatchOnExpressionParameter_StillFailsWithDiagnostic() {
        // The Expression parameter's own delegate declares zero lambda parameters where the
        // receiver-closed shape requires exactly one — the generalized substitution must not silently
        // accept an incompatible lambda shape.
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.PrimaryKey("PK_Accounts", () -> "unrelated")
    })
}`, expectSuccess: false)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    @Fact
    func NegativeControl_UnknownMemberOnReceiverStillFailsWithDiagnostic() {
        // Sanity control: an unrelated/nonexistent member call on the same symbolic receiver must not
        // be swallowed by the generalized substitution recovery — it should still fail to resolve.
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.NoSuchMethod("PK_Accounts", (x Cols) -> x.Id)
    })
}`, expectSuccess: false)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    @Fact
    func NegativeControl_ArityMismatchOnCompositeExpressionParameter_StillFailsWithDiagnostic() {
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.PrimaryKeyComposite("PK_Accounts", (a Cols) -> a.Id)
    })
}`, expectSuccess: false)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    @Fact
    func AmbiguityControl_OverloadedByArityStillRanksToExactMatch() {
        // Overload-ranking coverage: PrimaryKey and PrimaryKeyWithUnique share the same receiver-closed
        // Expression[Func[TColumns,object]] SHAPE but differ in arity/extra leading parameter; the
        // generalized substitution must not cause the wrong overload (or an ambiguous result) to be
        // picked for either call.
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.PrimaryKey("PK_Accounts", (x Cols) -> x.Id)
        table.PrimaryKeyWithUnique("PK_Accounts2", true, (x Cols) -> x.Id)
    })
}`)
        AssertBindsCleanly(result)
    }

    /// Synthetic reconstruction of the reported Oahu.Data migration regression: a generic
    /// `CreateTable<TColumns>(name, columns, schema, constraints)` call whose constraints
    /// lambda invokes BOTH the fluent, self-returning `Annotation` call (issue #2345's shape) AND
    /// the expression-tree-parameter `PrimaryKey` call (issue #2365's shape) together, matching the
    /// real-world file's combined usage.
    @Fact
    func OahuDataStyleMigrationRegression_AnnotationAndPrimaryKeyTogether_Binds() {
        let result = CompileAgainstLibrary(`package Demo
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
}`)
        AssertBindsCleanly(result)
    }

    shared {
        private func AssertBindsCleanly(result EmitResult) {
            Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func CompileAgainstLibrary(consumerSource string, expectSuccess bool = true) EmitResult {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2365")
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "Issue2365.Library.dll")
            EmitLibraryAssembly(libraryPath)
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(consumerSource)))
            using let peStream = MemoryStream()
            let result = consumer.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "Issue2365.Consumer." + Guid.NewGuid().ToString("N")
            )
            return result
        }

        private func EmitLibraryAssembly(libraryPath string) {
            if File.Exists(libraryPath) {
                // Reused across [Fact]s in this class; each test compiles a distinct consumer assembly
                // against the same cached library, mirroring Issue2142's / Issue2345's pattern.
                return
            }
            let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Lib
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
}`))){IsLibrary = true}
            using let peStream = File.Create(libraryPath)
            let result = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue2365.Library")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
    }
}
