// inventory: ArgListExpression — UnsupportedByDesign/NoGsharpConstruct
// Legacy varargs (__arglist); G# has no analog and none is planned.
namespace Cs2Gs.Fixtures.Unsupported;

public static class ArgListFixture
{
    public static int CountArgs(__arglist)
    {
        var iterator = new System.ArgIterator(__arglist);
        return iterator.GetRemainingCount();
    }

    public static int CallIt()
    {
        return CountArgs(__arglist(1, 2, 3));
    }
}
