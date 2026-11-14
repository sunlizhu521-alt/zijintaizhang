export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_MESSAGE = '密码须为6至128个字符，且同时包含英文字母和数字';

export function isValidPassword(password) {
  if (typeof password !== 'string' || password.length > PASSWORD_MAX_LENGTH * 2) return false;
  const length = [...password].length;
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH
    && /[A-Za-z]/.test(password) && /[0-9]/.test(password);
}
