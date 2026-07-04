// inventory: ObjectInitializerExpression — object initializer, including a
// `required` member (issue #1892: previously any object initializer emitted
// stray bare assignment statements before the composite literal).
using System;

namespace Corpus.Grid06
{
    public class ProfileCard
    {
        public required string Name { get; set; } = "";

        public int Age { get; set; }
    }

    public static class RequiredMemberFixture
    {
        public static void Run()
        {
            ProfileCard card = new ProfileCard { Name = "ada", Age = 36 };
            Console.WriteLine("RequiredMember: name=" + card.Name + " age=" + card.Age.ToString());
        }
    }
}
