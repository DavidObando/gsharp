// inventory: RefValueExpression — UnsupportedByDesign/NoGsharpConstruct
// Legacy TypedReference machinery; G# has no analog and none is planned.
namespace Cs2Gs.Fixtures.Unsupported;

public static class RefValueFixture
{
    public static int ReadBack()
    {
        int value = 3;
        System.TypedReference reference = __makeref(value);
        return __refvalue(reference, int);
    }
}
