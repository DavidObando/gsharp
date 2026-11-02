// <copyright file="RegionEffects.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable

/// The value that a write stores, for proof rule P7 (ADR-0213 section 8). The
/// scanner records the syntax shape. The consumer decides with the binder's
/// scope and types whether the shape is a proof.
internal enum RegionWriteProof {
    /// The value is not a proof: a variable, a call, a conversion, `??`, `?:`, a cast.
    None,
    /// A literal that is not `nil`.
    NonNilLiteral,
    /// A construction `T(...)` or `T{...}`. The write records the type name.
    Construction,
    /// `value!!`. It proves nullability only.
    NullAssertion
}

/// The syntax shape of a call site (ADR-0213 section 7, rule W4).
internal enum RegionCallKind {
    /// `F(args)` where the callee is a simple name.
    NamedInvocation,
    /// `receiver.M(args)`. The walker resolves nothing about the member.
    MemberInvocation,
    /// A call whose callee is an expression, such as `f()(x)`.
    ExpressionInvocation,
    /// A construction: a struct literal, an object creation, an anonymous class.
    Construction,
    /// Any other code the walker cannot see: `await`, `yield`, `go`, a channel
    /// operation, an interpolated string, a base call, cleanup.
    Other
}

/// One write to a plain name, found by the scanner.
internal sealed class RegionWrite {
    init(
        name string,
        position int32,
        proof RegionWriteProof,
        constructedTypeName string?,
        rightSideName string?,
        rightSideDeclaration string?,
        viaCallArgument bool,
        followedByExit bool
    ) {
        Name = name
        Position = position
        Proof = proof
        ConstructedTypeName = constructedTypeName
        RightSideName = rightSideName
        RightSideDeclaration = rightSideDeclaration
        ViaCallArgument = viaCallArgument
        FollowedByExit = followedByExit
    }

    /// Gets the name that the write targets. The consumer resolves it at the region's entry scope.
    prop Name string {
        get;
    }

    /// Gets the position of the write in the source text.
    prop Position int32 {
        get;
    }

    prop Proof RegionWriteProof {
        get;
    }

    /// Gets the type name of a construction, or `nil`.
    prop ConstructedTypeName string? {
        get;
    }

    /// Gets the name on the right side when the right side is a plain name, or `nil`.
    prop RightSideName string? {
        get;
    }

    /// Gets how the region declares the name on the right side: `pattern` for a pattern variable,
    /// `binding` for an `if let`, `guard let` or `while let` binding, `local` for another declaration,
    /// or `nil` when the region does not declare it. ADR-0213 question 4 asks about the first two.
    prop RightSideDeclaration string? {
        get;
    }

    /// Whether the name is written by passing it as a `ref`/`out` argument or an `&` operand.
    prop ViaCallArgument bool {
        get;
    }

    /// Whether an unconditional `break`, `return`, `throw` or `goto` follows the write in its
    /// statement list. The report uses this to attribute a kill to row R7 (a).
    prop FollowedByExit bool {
        get;
        set;
    }
}

/// A type test of a name that the region does not declare: the binder looks up the members of the name on the
/// tested type where the test holds (ADR-0213, function values).
internal sealed class RegionTypeTest {
    init(name string, typeName string?, arity int32, mayBeConstant bool) {
        Name = name
        TypeName = typeName
        Arity = arity
        MayBeConstant = mayBeConstant
    }

    /// Gets the tested name.
    prop Name string {
        get;
    }

    /// Gets the name of the tested type, or `nil` when the type is not a plain or dotted name.
    prop TypeName string? {
        get;
    }

    /// Gets the number of type arguments of the tested type.
    prop Arity int32 {
        get;
    }

    /// Whether the pattern is name-shaped, so it tests a constant when the name is not a type.
    prop MayBeConstant bool {
        get;
    }
}

/// A step of a receiver path: a member read, a method call or an indexing (`Element` is the element of an
/// iteration).
internal enum RegionReceiverStepKind {
    Member,
    Call,
    Index,
    Element,
}

/// One step of a receiver path.
internal sealed class RegionReceiverStep {
    init(kind RegionReceiverStepKind, name string?) {
        Kind = kind
        Name = name
    }

    prop Kind RegionReceiverStepKind {
        get;
    }

    /// Gets the member name of a `Member` or `Call` step, or `nil`.
    prop Name string? {
        get;
    }
}

/// The receiver of a member call that is not a plain name of the entry scope (ADR-0213, function values): a root
/// that the entry scope resolves, and the member reads, calls and indexings that follow it. A local of the region
/// is replaced by the path of its declared type or of its initializer.
internal sealed class RegionReceiverPath {
    init(
        rootName string?,
        rootIsCall bool,
        rootType TypeClauseSyntax?,
        rootLiteralType string?,
        steps ImmutableArray[RegionReceiverStep]
    ) {
        RootName = rootName
        RootIsCall = rootIsCall
        RootType = rootType
        RootLiteralType = rootLiteralType
        Steps = steps
    }

    /// Gets the root name: a name of the entry scope, or the callee of a call when (cref:RootIsCall) is set.
    prop RootName string? {
        get;
    }

    prop RootIsCall bool {
        get;
    }

    /// Gets the declared type of a local of the region that roots the path.
    prop RootType TypeClauseSyntax? {
        get;
    }

    /// Gets the CLR type name of a literal that roots the path.
    prop RootLiteralType string? {
        get;
    }

    prop Steps ImmutableArray[RegionReceiverStep] {
        get;
    }

    /// Returns the path with one more step.
    func Append(kind RegionReceiverStepKind, name string?) RegionReceiverPath -> RegionReceiverPath(
        RootName,
        RootIsCall,
        RootType,
        RootLiteralType,
        Steps.Add(RegionReceiverStep(kind, name))
    )

    /// Returns the path with the steps of [`tail`](paramref) after its own.
    func Concat(tail RegionReceiverPath) RegionReceiverPath -> RegionReceiverPath(
        RootName,
        RootIsCall,
        RootType,
        RootLiteralType,
        Steps.AddRange(tail.Steps)
    )
}

/// A member or index read that the consumer resolves to decide whether a getter or an indexer can run user code
/// (ADR-0208 R14, R16 and R17; ADR-0213, coordinator decision 2026-11-01).
internal sealed class RegionMemberRead {
    init(receiver RegionReceiverPath?, member string?) {
        Receiver = receiver
        Member = member
    }

    /// Gets the path of the receiver, or `nil` when the walker cannot follow it.
    prop Receiver RegionReceiverPath? {
        get;
    }

    /// Gets the name of the member that is read, or `nil` for an index read.
    prop Member string? {
        get;
    }
}

/// An operator whose operands are names or literals; the consumer decides whether it is predefined
/// (ADR-0208 construct table: a user-defined operator is a call).
internal sealed class RegionOperator {
    init(kind SyntaxKind, operands List[RegionReceiverPath?], operatorForms List[bool]) {
        Kind = kind
        Operands = operands
        OperatorForms = operatorForms
    }

    /// Gets the operator token kind (a compound assignment gives its base operator).
    prop Kind SyntaxKind {
        get;
    }

    /// Gets the paths of the operands: one for a unary operator, two for a binary one.
    prop Operands List[RegionReceiverPath?] {
        get;
    }

    /// Gets, for each operand, whether it is itself an operator expression, whose value has a built-in type when
    /// its own operands do (that operator is recorded on its own).
    prop OperatorForms List[bool] {
        get;
    }
}

/// A site where the binder converts a value to a target type (rule W4); the consumer asks whether a user-defined
/// or imported conversion operator can run there. A `nil` source or target is one the walker cannot follow.
internal sealed class RegionConversion {
    init(source RegionReceiverPath?, target RegionReceiverPath?, sourceIsBuiltInByForm bool, sourceIsNil bool = false) {
        Source = source
        Target = target
        SourceIsBuiltInByForm = sourceIsBuiltInByForm
        SourceIsNil = sourceIsNil
    }

    prop Source RegionReceiverPath? {
        get;
    }

    prop Target RegionReceiverPath? {
        get;
    }

    /// Whether the source is an operator or a literal, whose value has a built-in type when its operands do.
    prop SourceIsBuiltInByForm bool {
        get;
    }

    /// Whether the source is `nil`, which reaches a non-nullable value type only through a conversion operator.
    prop SourceIsNil bool {
        get;
    }
}

/// How an argument reaches its parameter, for the consumer's check of argument conversions.
internal enum RegionArgumentForm {
    /// A value with a path (`nil` when the walker cannot follow it).
    Path,
    /// A `ref`, `out`, `in` or address argument, which binds by exact type.
    ByReference,
    /// An operator or literal expression, whose value is built in when its operators are predefined.
    BuiltInByForm,
    /// A function literal, which converts to a delegate without an operator.
    FunctionLiteral,
    /// `nil`, which stores the null value.
    Nil,
    /// A named argument, which the walker does not match to a parameter.
    Named,
    /// A string concatenation with an operand that is not a string literal (`"a" + x`): a `string` when the
    /// operators of the region are predefined.
    StringByForm,
    /// An `out var` or `out let` declaration, which takes the parameter's type.
    InlineDeclaration,
    /// A range index (`t[a..b]`), which the binder slices; the read classification decides whether that runs code.
    Range,
}

/// One call site found by the scanner.
internal sealed class RegionCall {
    init(
        kind RegionCallKind,
        calleeName string?,
        byReferenceNames List[string],
        byValueNames List[string],
        hasUnresolvedOperand bool,
        position int32,
        receiverName string? = nil,
        receiver RegionReceiverPath? = nil,
        arguments List[RegionReceiverPath?]? = nil,
        argumentForms List[RegionArgumentForm]? = nil,
        hasTypeArguments bool = false
    ) {
        ArgumentForms = argumentForms ?? List[RegionArgumentForm]()
        HasTypeArguments = hasTypeArguments
        Kind = kind
        CalleeName = calleeName
        ReceiverName = receiverName
        Receiver = receiver
        Arguments = arguments ?? List[RegionReceiverPath?]()
        ByReferenceNames = byReferenceNames
        ByValueNames = byValueNames
        HasUnresolvedOperand = hasUnresolvedOperand
        Position = position
    }

    prop Kind RegionCallKind {
        get;
    }

    /// Gets the name of the callee for a named invocation, or of the member for a member invocation, or `nil`.
    prop CalleeName string? {
        get;
    }

    /// Gets the plain name of the receiver of a member invocation when the region does not declare it, or `nil`.
    prop ReceiverName string? {
        get;
    }

    /// Gets the path of the receiver of a member invocation whose receiver is not a plain name of the entry scope,
    /// or `nil` when the walker cannot follow it.
    prop Receiver RegionReceiverPath? {
        get;
    }

    /// Whether the call names its type arguments (`F[T](x)`), so a parameter of a type parameter has that type.
    prop HasTypeArguments bool {
        get;
    }

    /// Gets the path of each argument, in argument order (`nil` for one that has no path; see (cref:ArgumentForms)).
    prop Arguments List[RegionReceiverPath?] {
        get;
    }

    /// Gets the form of each argument, in argument order.
    prop ArgumentForms List[RegionArgumentForm] {
        get;
    }

    /// Gets the names passed by `ref` or `out`, in argument order.
    prop ByReferenceNames List[string] {
        get;
    }

    /// Gets the names passed by value, receiver included, in argument order.
    prop ByValueNames List[string] {
        get;
    }

    /// Whether an operand is not a plain name. The walker answers the alias question as
    /// "may reach any storage" for such an operand.
    prop HasUnresolvedOperand bool {
        get;
    }

    prop Position int32 {
        get;
    }
}

/// What a region of syntax does to the narrowing facts that hold at its entry
/// (ADR-0213 section 7). The scanner builds the record and the consumer reads
/// it. Names are in order of first appearance, so no result depends on hash order.
internal sealed class RegionEffects {
    private let writeNames HashSet[string] = HashSet[string]()

    init() {
        Writes = List[RegionWrite]()
        Calls = List[RegionCall]()
        IndexAccesses = List[RegionCall]()
        PatternReads = List[RegionMemberRead]()
        NilCompareOperandPaths = List[RegionReceiverPath?]()
        Declared = List[string]()
        BareReads = List[string]()
        OperatorOperandNames = List[string]()
        NilCompareOperandNames = List[string]()
        ReturnedNames = List[string]()
        TypeTests = List[RegionTypeTest]()
        MemberReads = List[RegionMemberRead]()
        Operators = List[RegionOperator]()
        Conversions = List[RegionConversion]()
    }

    /// Gets the writes to names that no declaration inside the region encloses (rule W1), in
    /// source order of the walk.
    prop Writes List[RegionWrite] {
        get;
    }

    /// Gets the call sites with an operand analysis, in source order of the walk.
    prop Calls List[RegionCall] {
        get;
    }

    /// Gets the index accesses (`t[i]`), each as a call of the member `[]` on the target, for the consumer's check of
    /// index argument conversions. They are not calls.
    prop IndexAccesses List[RegionCall] {
        get;
    }

    /// Gets the reads of a constant pattern (`key is holder.P`), which can name a type or a constant instead.
    prop PatternReads List[RegionMemberRead] {
        get;
    }

    /// Gets the member and element operands compared with `nil` (`holder.Token == nil`), or `nil` for one that
    /// has no path.
    prop NilCompareOperandPaths List[RegionReceiverPath?] {
        get;
    }

    /// Gets the operators whose operands are names or literals, in source order of the walk.
    prop Operators List[RegionOperator] {
        get;
    }

    /// Gets the conversion sites, in source order of the walk.
    prop Conversions List[RegionConversion] {
        get;
    }

    /// Gets the member and index reads, in source order of the walk.
    prop MemberReads List[RegionMemberRead] {
        get;
    }

    /// Whether the region has a type test of something other than a plain name (a member or an element).
    prop ContainsMemberTypeTest bool {
        get;
        set;
    }

    /// Gets the type tests of names that the region does not declare, in source order of the walk.
    prop TypeTests List[RegionTypeTest] {
        get;
    }

    /// Gets the names that the region declares at its top level, for diagnostics of the report.
    prop Declared List[string] {
        get;
    }

    prop ContainsCall bool {
        get;
        set;
    }

    prop ContainsMemberWrite bool {
        get;
        set;
    }

    prop ContainsMemberRead bool {
        get;
        set;
    }

    prop ContainsPointerWrite bool {
        get;
        set;
    }

    prop ContainsAliasTake bool {
        get;
        set;
    }

    prop ContainsRefOrOutArgument bool {
        get;
        set;
    }

    prop ContainsClosure bool {
        get;
        set;
    }

    prop ContainsSuspension bool {
        get;
        set;
    }

    /// Whether a `catch` clause occurs in the region (rule W8).
    prop ContainsHandler bool {
        get;
        set;
    }

    prop ContainsUnknownKind bool {
        get;
        set;
    }

    /// Whether a binary or unary operator with no literal operand occurs. A user-defined operator
    /// runs code. The walker cannot rule it out, so it only counts them (see the PR notes).
    prop ContainsOperatorCandidate bool {
        get;
        set;
    }

    /// Whether the iteration of a `for ... in` loop, a channel receive loop or an `await for` loop
    /// is in the region (rule W4, table T5 and T7).
    prop ContainsIteration bool {
        get;
        set;
    }

    /// Whether a `goto` or a label occurs in the region.
    prop ContainsGoto bool {
        get;
        set;
    }

    /// Gets the plain names compared with `nil` (a leading `?` marks a name that the region declares).
    prop NilCompareOperandNames List[string] {
        get;
    }

    /// Whether a declaration with a type or an assignment takes a value that is not a literal. A user-defined
    /// conversion may run code there (rule W4); the consumer asks whether the package declares any.
    prop ContainsConversionCandidate bool {
        get;
        set;
    }

    /// Gets the names read in the region that no declaration of the region encloses (a bare name can bind to a
    /// property getter of the enclosing type; the consumer resolves it at the entry scope, rule W5).
    prop BareReads List[string] {
        get;
    }

    /// Gets the plain names that a `return` of the region converts to the return type, in order of first appearance.
    /// The consumer asks whether a conversion operator can run there (rule W4).
    prop ReturnedNames List[string] {
        get;
    }

    /// Whether a `return` of the region converts a literal or a `nameof` to the return type (rule W4).
    prop ReturnsConstant bool {
        get;
        set;
    }

    /// Gets the names that are operands of an operator candidate (a binary or unary operator with no literal
    /// operand), in order of first appearance.
    prop OperatorOperandNames List[string] {
        get;
    }

    /// Whether an operator candidate has an operand that is not a plain name or a literal (a user-defined operator
    /// may be selected by its type, which the walker cannot see).
    prop OperatorHasUnresolvedOperand bool {
        get;
        set;
    }

    /// Gets the number of member and index reads in the region (rule W5).
    prop MemberReadCount int32 {
        get;
        set;
    }

    /// Gets the number of syntax nodes the walk visited to build this record.
    prop NodesVisited int32 {
        get;
        set;
    }

    /// Whether some write targets [`name`](paramref).
    func WritesName(name string) bool -> writeNames.Contains(name)

    /// Adds a write.
    func AddWrite(write RegionWrite) {
        Writes.Add(write)
        writeNames.Add(write.Name)
    }

    /// Adds the flags and the call sites of a nested record. The scanner composes the writes itself,
    /// because a write to a name that the enclosing region declares is region-local or reaches the
    /// storage of a `ref` local (rules W1 and W3). When [`includeCode`](paramref) is false the nested
    /// region only creates a closure, so only what it can write to captured names and the closure itself
    /// count (rule W7).
    func AbsorbFlags(other RegionEffects, includeCode bool) {
        ContainsClosure = ContainsClosure || other.ContainsClosure
        ContainsUnknownKind = ContainsUnknownKind || other.ContainsUnknownKind
        ContainsGoto = ContainsGoto || other.ContainsGoto
        if !includeCode {
            return
        }
        Calls.AddRange(other.Calls)
        IndexAccesses.AddRange(other.IndexAccesses)
        PatternReads.AddRange(other.PatternReads)
        NilCompareOperandPaths.AddRange(other.NilCompareOperandPaths)
        MemberReads.AddRange(other.MemberReads)
        Operators.AddRange(other.Operators)
        Conversions.AddRange(other.Conversions)
        ContainsMemberTypeTest = ContainsMemberTypeTest || other.ContainsMemberTypeTest
        TypeTests.AddRange(other.TypeTests)
        ContainsCall = ContainsCall || other.ContainsCall
        ContainsMemberWrite = ContainsMemberWrite || other.ContainsMemberWrite
        ContainsMemberRead = ContainsMemberRead || other.ContainsMemberRead
        ContainsPointerWrite = ContainsPointerWrite || other.ContainsPointerWrite
        ContainsAliasTake = ContainsAliasTake || other.ContainsAliasTake
        ContainsRefOrOutArgument = ContainsRefOrOutArgument || other.ContainsRefOrOutArgument
        ContainsSuspension = ContainsSuspension || other.ContainsSuspension
        ContainsHandler = ContainsHandler || other.ContainsHandler
        ContainsOperatorCandidate = ContainsOperatorCandidate || other.ContainsOperatorCandidate
        ContainsIteration = ContainsIteration || other.ContainsIteration
        MemberReadCount = MemberReadCount + other.MemberReadCount
        ContainsConversionCandidate = ContainsConversionCandidate || other.ContainsConversionCandidate
        ReturnsConstant = ReturnsConstant || other.ReturnsConstant
        for name in other.ReturnedNames {
            if !ReturnedNames.Contains(name) {
                ReturnedNames.Add(name)
            }
        }
        OperatorHasUnresolvedOperand = OperatorHasUnresolvedOperand || other.OperatorHasUnresolvedOperand
        for name in other.NilCompareOperandNames {
            if !NilCompareOperandNames.Contains(name) {
                NilCompareOperandNames.Add(name)
            }
        }
        for name in other.OperatorOperandNames {
            if !OperatorOperandNames.Contains(name) {
                OperatorOperandNames.Add(name)
            }
        }
        for name in other.BareReads {
            if !BareReads.Contains(name) {
                BareReads.Add(name)
            }
        }
    }

    /// A compact text of the record, for the report and for tests: the flags set, then the
    /// written names in order.
    override func ToString() string {
        let flags = List[string]()
        if ContainsCall {
            flags.Add("call")
        }
        if ContainsMemberWrite {
            flags.Add("member-write")
        }
        if ContainsMemberRead {
            flags.Add("member-read")
        }
        if ContainsPointerWrite {
            flags.Add("pointer-write")
        }
        if ContainsAliasTake {
            flags.Add("alias-take")
        }
        if ContainsRefOrOutArgument {
            flags.Add("ref-arg")
        }
        if ContainsClosure {
            flags.Add("closure")
        }
        if ContainsSuspension {
            flags.Add("suspension")
        }
        if ContainsHandler {
            flags.Add("handler")
        }
        if ContainsUnknownKind {
            flags.Add("unknown-kind")
        }
        if ContainsOperatorCandidate {
            flags.Add("operator")
        }
        if ContainsIteration {
            flags.Add("iteration")
        }
        if ContainsGoto {
            flags.Add("goto")
        }
        let names = List[string]()
        for write in Writes {
            if !names.Contains(write.Name) {
                names.Add(write.Name)
            }
        }
        return "flags=[${string.Join(",", flags)}] writes=[${string.Join(",", names)}]"
    }
}
