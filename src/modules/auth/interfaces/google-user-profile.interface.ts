export interface GoogleUserProfile {
  email: string;
  googleId: string; // payload.sub
  firstName?: string; // payload.given_name
  lastName?: string; // payload.family_name
  picture?: string; // payload.picture
}
