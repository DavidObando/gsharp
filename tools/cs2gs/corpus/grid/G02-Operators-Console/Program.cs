// G02-Operators-Console: operator constructs, one fixture per file,
// invoked in file-name order. Stdout is the parity oracle.
using System;

namespace Corpus.Grid02
{
    internal static class Program
    {
        private static void Main()
        {
            AddAssignmentExpressionFixture.Run();
            AddExpressionFixture.Run();
            AndAssignmentExpressionFixture.Run();
            AsExpressionFixture.Run();
            BitwiseAndExpressionFixture.Run();
            BitwiseNotExpressionFixture.Run();
            BitwiseOrExpressionFixture.Run();
            CastExpressionFixture.Run();
            CheckedExpressionFixture.Run();
            CoalesceAssignmentExpressionFixture.Run();
            CoalesceExpressionFixture.Run();
            ConditionalAccessExpressionFixture.Run();
            ConditionalExpressionFixture.Run();
            DefaultExpressionFixture.Run();
            DivideAssignmentExpressionFixture.Run();
            DivideExpressionFixture.Run();
            ElementBindingExpressionFixture.Run();
            EqualsExpressionFixture.Run();
            ExclusiveOrAssignmentExpressionFixture.Run();
            ExclusiveOrExpressionFixture.Run();
            GreaterThanExpressionFixture.Run();
            GreaterThanOrEqualExpressionFixture.Run();
            IsExpressionFixture.Run();
            LeftShiftAssignmentExpressionFixture.Run();
            LeftShiftExpressionFixture.Run();
            LessThanExpressionFixture.Run();
            LessThanOrEqualExpressionFixture.Run();
            LogicalAndExpressionFixture.Run();
            LogicalNotExpressionFixture.Run();
            LogicalOrExpressionFixture.Run();
            MemberBindingExpressionFixture.Run();
            ModuloAssignmentExpressionFixture.Run();
            ModuloExpressionFixture.Run();
            MultiplyAssignmentExpressionFixture.Run();
            MultiplyExpressionFixture.Run();
            NameOfExpressionFixture.Run();
            NotEqualsExpressionFixture.Run();
            OrAssignmentExpressionFixture.Run();
            PostDecrementExpressionFixture.Run();
            PostIncrementExpressionFixture.Run();
            PreDecrementExpressionFixture.Run();
            PreIncrementExpressionFixture.Run();
            RightShiftAssignmentExpressionFixture.Run();
            RightShiftExpressionFixture.Run();
            SimpleAssignmentExpressionFixture.Run();
            SizeOfExpressionFixture.Run();
            SubtractAssignmentExpressionFixture.Run();
            SubtractExpressionFixture.Run();
            SuppressNullableWarningExpressionFixture.Run();
            TypeOfExpressionFixture.Run();
            UnaryMinusExpressionFixture.Run();
            UnaryPlusExpressionFixture.Run();
            UncheckedExpressionFixture.Run();
            UnsignedRightShiftAssignmentExpressionFixture.Run();
            UnsignedRightShiftExpressionFixture.Run();
        }
    }
}
